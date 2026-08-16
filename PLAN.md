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

**Order of work:** 1.5 correctness → two-file `diff` (from Phase 3) →
Distribution → Phase 2 sources → snap/diff state → Phase 4 niceties.

## Phase 1.5 — correctness gaps (do first, cheap)

**Fix-run notes for the executing session:** work top to bottom; every fix
gets a test case (extend `test/cluster.test.ts` unless the item says
otherwise); tick each box as its verify passes; done = all boxes ticked +
`snuff` green in this repo. Zero runtime deps stays a hard rule. If an item
can't be done as written, leave it unticked and note why beneath it — don't
improvise a different design.

- [x] `<hex>` swallows long decimals (confirmed) — `src/mask.ts`, hex rule.
      `[0-9a-f]{12,}` matches all-digit runs: `1755335820000` → `<hex>` while
      an 11-digit value in the same field → `<n>` — one field, two templates.
      Fix: require ≥1 letter: `/\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi`.
      Verify: `mask('ts 1755335820000 tok deadbeefdeadbeef')` →
      `'ts <n> tok <hex>'`.
- [x] Mixed file/stdin args drop files (confirmed) — `src/index.ts`,
      `readLines()`. `squirt app.log -` reads only stdin: sources collapse to
      `['-']` whenever `-` is present. Fix: `files.length > 0 ? files : ['-']`,
      each `-` entry = stdin, consumed in argv order; throw
      `stdin ('-') given more than once` on repeats.
      Verify (manual): `printf 'ERROR a\n' >/tmp/f;
      printf 'ERROR b\n' | squirt /tmp/f -` → 2 signatures.
- [x] Strip ANSI colour codes before parsing — `src/cluster.ts`, top of the
      line loop. Colourised docker/kubectl output corrupts templates and
      level detection. Fix: after trimEnd,
      `raw = raw.replace(/\x1b\[[0-9;]*m/g, '')` (SGR is enough).
      Verify: `'\x1b[31mERROR\x1b[0m boom'` → level ERROR, template `boom`.
- [x] No continuation folding after JSON lines — `src/cluster.ts`.
      JSON-lines never emit stack-trace continuations; an indented line after
      a JSON record is a new (pretty-printed) record. Fix: remember whether
      the previous parsed line was JSON; if so, skip the CONTINUATION branch.
      Verify: a JSON line followed by `'    at foo'` → 2 signatures, folded=0.
- [x] Surface the first useful folded line — `src/types.ts` + `src/cluster.ts`
      + `src/render.ts`. Add `detail?: string` to Signature; while folding,
      if `sig.detail` is unset and the line matches
      `/^\s*(Caused by:|[\w.]*(Error|Exception):)/`, store it (trimmed,
      ≤200 chars). renderText prints `  ⤷ <detail>` after the sample; include
      the field in JSON output.
      Verify: ERROR line + `'    Caused by: ETIMEDOUT'` → digest shows the
      `⤷ Caused by: ETIMEDOUT` line.
- [x] Level body-scan too eager — `src/cluster.ts`, `parseText()` fallback.
      Scanning 120 chars of body for any level makes `'user asked for INFO'`
      an INFO line. Fix: the body-scan fallback may only assign
      ERROR/WARN-family tokens (FATAL, PANIC, CRITICAL, CRIT, ERROR, ERR,
      WARNING, WARN); INFO/DEBUG/TRACE come only from a leading token or a
      JSON field.
      Verify: `'user asked for INFO x'` → OTHER; `'reconnect after ERROR'` →
      ERROR.
- [x] `<str>` and `<path>` mask rules — `src/mask.ts`, insert after `<email>`.
      The two biggest sources of near-duplicate signatures in app logs.
      `<str>`: `/(?<!\w)"[^"]{1,120}"|(?<!\w)'[^']{1,120}'/g` (lookbehind so
      apostrophes in `can't` don't open a string). `<path>` after `<str>`:
      `/(?<![\w.])\/[\w.-]+(\/[\w.-]+)+/g` (two+ segments, so a bare `/` or
      version strings don't match).
      Verify: `open "/data/x1.json" failed` → `open <str> failed`;
      `read /var/log/app.log` → `read <path>`; `can't open 'x'` →
      `can't open <str>`.
- [x] Day marker when the span crosses midnight — `src/render.ts`.
      26h of input renders `23:10→01:02`. Fix: when the date parts of
      firstSeen/lastSeen differ, render `MM-DD HH:MM` on both sides (for
      syslog timestamps use the `Aug 16` part as-is).
      Verify: first `2026-08-15T23:10:00Z`, last `2026-08-16T01:02:00Z` →
      `08-15 23:10→08-16 01:02`.
- [x] Header shape — `src/render.ts`: `N signatures · M lines (K folded)`,
      dropping the `· K continuation lines folded` clause. Update any test
      expectations that match the old header.
- [x] kubectl `--prefix` lines — `src/cluster.ts`. Lines start
      `[pod/<name>/<container>] `. Strip the prefix before parsing so
      multi-pod streams collapse into one signature; record the first-seen
      pod name and show it in the sample: `↳ [api-7f9] …`.
      Verify: two lines from different pods, same message → 1 signature ×2.
      (This covers 90% of what a `--merge` feature would.)

## Phase 2 — sources (done)

Shell out so users don't have to remember the incantation. Unknown args are
forwarded verbatim; squirt only adds what makes output digestible.

- [x] `squirt k8s -n <ns> [deploy/<name>] [--since 1h]` → `kubectl logs
      --timestamps --prefix --all-containers` (multi-pod: pod tag on samples)
- [x] `squirt docker <container> [--since 1h]` → `docker logs --timestamps`,
      stdout+stderr merged
- [x] `squirt journal <unit>` → `journalctl --no-pager -u <unit> -o short-iso`

## Phase 3 — baseline diff (prioritise over Phase 2)

The single highest-value debugging question is "what's new since the deploy":

- [x] `squirt diff <before.log> <after.log>` — stateless two-file diff first: no
  snapshot state, easy to test, works in CI
- [x] `squirt snap <name>` — save the current signature set
  (`~/.squirt/<scope-tail>-<hash>/<name>.json`, keyed by cwd or an explicit `--scope`)
- [x] `squirt diff <name>` — digest input, show only signatures absent from the
  snapshot (or with a large count jump: ≥3× and ≥5)

## Phase 4 — niceties (ranked, all done)

1. [x] time-bucketed sparkline per signature (`▁▁▁▇█▃`, ~10 chars) — answers
   "started at 09:14 or always there?"; dense enough for the digest
2. [x] `--level warn` minimum-severity filter; `--grep <re>` — fixes "the one I
   care about is #23" without raising `--top`
3. [x] `--sample <n>` — multiple samples for ERROR only, one for the rest
4. [x] `--tokens <n>` budget mode: render adaptively shrinks top / drops samples
   to fit (chars/4 estimate) — the feature that most directly reflects the
   "fits in AI context" purpose
5. [x] `--mask '<regex>'` ad-hoc extra rule (instead of `~/.squirt/rules` — a
   regex config file is a support burden)
6. [x] `--merge` multi-file provenance (mostly covered by kubectl-prefix detection)

## Distribution (done)

- [x] Ship a `SKILL.md` / `.claude` snippet: "when logs > 200 lines, pipe through
  squirt" — value only realised if agents reach for it automatically
  (`skills/squirt/SKILL.md`, `.claude-snippet.md`)
- [x] README: `--json` schema stability note, `-` stdin marker

## Phase 5 — ideas backlog (unranked, second pass)

Parsing / clustering
- Multi-line JSON & pretty-printed objects: a `{` line followed by indented
  keys is currently N junk signatures. Detect and fold into the opener.
- Key=value logs (logfmt: `level=info msg="…" dur=12ms`): mask the values,
  keep the keys → templates like `msg=<str> dur=<n>ms` collapse properly.
- Rare-signature promotion: a signature seen once, at ERROR, in the last 5% of
  the stream is the thing that broke — bubble it above high-count noise
  (sort key: severity, then "novelty", then count).
- Near-duplicate merge: two templates differing only in one token
  (`<n>` vs literal `0`) — Levenshtein ≤ 2 on tokenised template → merge.
  Bounded, only among same-level signatures, top-N only (keep it O(k²)).
- Short hex ids (6–11 chars: `cafe12` → `cafe<n>` today, near-dupe templates)
  need a heuristic that doesn't eat real words; also `sha256:…` prefixes and
  base64 blobs (`[A-Za-z0-9+/]{20,}={0,2}`) → `<b64>`.
- Timestamps in the middle of a message (`at 2026-08-16T09:14…`) → `<ts>`.

Output
- `--wide` / `--no-sample`: agents want compact; humans sometimes want the
  sample line unclipped.
- Stable signature ids (short hash of `level+template`) in text and JSON —
  lets diff/snap reference them and lets an agent say "show me #a3f".
- `--show <id>`: dump the raw lines behind one signature (bounded, `--limit`),
  the drill-down step after the digest.
- Exit code 1 if any ERROR signature present (`--fail-on error`) — turns
  squirt into a CI gate.
- Percentages next to counts (`×2,100 (25%)`) — cheap, orients faster.

Robustness
- Huge single lines (base64 dumps, minified stack) — cap per-line work,
  truncate before masking to keep regexes linear.
- Non-UTF8 / binary detection: bail with a one-line notice instead of a
  digest of garbage.
- Perf budget test: 1M lines in < N s, memory flat — guard the streaming claim.

Ecosystem
- `--format claude|md`: fenced markdown block ready to paste; trivial, high
  use.
- Library entry (`import { cluster } from 'squirt'`) with a documented API,
  so it can be embedded in an MCP server / other tools without shelling out.
- MCP server wrapper (separate package, may take deps) exposing
  `digest(text)` and `diff(a, b)` — the natural distribution channel for the
  "keep raw logs out of AI context" purpose.

## Non-goals

- Not a log store or shipper — one-shot compression only.
- No daemon, no config file required, no runtime npm deps.
