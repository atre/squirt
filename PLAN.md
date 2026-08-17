# squirt — plan

> **How to run this plan (agent):** read `CLAUDE.md` first; work top-down inside a phase; each open item states *what / why / accept* — do not tick `[x]` until its accept check passes; tests never touch the network or the real cluster (fixtures); `snuff` green = done (Stop hook runs it); append friction to `FEEDBACK.md`; never `git commit`/`push` unless the user says so; ask only when two readings lead to materially different work — otherwise pick the simpler one and say so.

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
`snuff` green in this repo. No-deps is the current state, not a rule — add a dep when it earns its keep. If an item
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
- [x] Multi-line JSON & pretty-printed objects: a `{` line followed by indented
  keys is currently N junk signatures. Detect and fold into the opener. → files: `src/cluster.ts` (line loop: a line that is `{` or ends with `{` opens a buffer; accumulate until brace depth returns to 0 (cap 200 lines), then run `parseJson` on the joined text; on overflow flush the buffered lines as plain text), `test/cluster.test.ts` · accept: `cluster(['{', '  "level": "error",', '  "msg": "boom"', '}'])` → `signatures.length === 1`, `level === 'ERROR'`, `template === 'boom'`, `lines === 4`, `folded === 0` · decide: `lines` keeps counting physical lines; a pretty-printed object followed by `    at foo` is not folded (same rule as single-line JSON today).
- [x] Key=value logs (logfmt: `level=info msg="…" dur=12ms`): mask the values,
  keep the keys → templates like `msg=<str> dur=<n>ms` collapse properly. → files: `src/cluster.ts` (new `parseLogfmt(raw)` tried after `parseJson`, before `parseText`: a line is logfmt when it starts with ≥ 2 `key=value` pairs; lift `level|lvl` → level via `levelFromString`, `time|ts` → ts, drop those two pairs, keep the rest in order as the message), `src/mask.ts` (rule appended after `<path>`: bare-word values `(?<=\b\w+=)[A-Za-z][\w.:-]*` → `<v>`), `test/cluster.test.ts` (extend 'masks quoted strings and paths' + one cluster case) · accept: `cluster(['level=info ts=2026-08-16T09:00:00Z msg="user login" user=alice dur=12ms', 'level=info ts=2026-08-16T09:00:05Z msg="user login" user=bob dur=40ms'])` → 1 signature, `level === 'INFO'`, `template === 'msg=<str> user=<v> dur=<n>ms'`, `firstSeen === '2026-08-16T09:00:00Z'` · decide: `<v>` applies only to the value side of `key=value` (lookbehind), never to free text.
- [x] Rare-signature promotion: a signature seen once, at ERROR, in the last 5% of
  the stream is the thing that broke — bubble it above high-count noise
  (sort key: severity, then "novelty", then count). → files: `src/cluster.ts` (track `firstEpoch` per signature (internal, next to `hist`); after grouping set `novel = level === 'ERROR' && count === 1 && firstEpoch >= time.start + 0.95 * (time.end - time.start)`; sort key severity → novel first → count), `src/types.ts` (`novel?: boolean`, internal like `hist`; strip it in `renderJson`/`renderDiffJson` alongside `hist`), `test/cluster.test.ts` · accept: 60 lines `2026-08-16T09:MM:00Z ERROR db timeout` (MM = 00…59) + one `2026-08-16T09:59:30Z ERROR disk full` → `signatures[0].template === 'disk full'`, `signatures[1].count === 60` · decide: order only, no marker in the text output; without timestamps nothing is promoted.
- [x] Near-duplicate merge: two templates differing only in one token
  (`<n>` vs literal `0`) — Levenshtein ≤ 2 on tokenised template → merge.
  Bounded, only among same-level signatures, top-N only (keep it O(k²)). → files: `src/cluster.ts` (post-pass `mergeNear(signatures)`: same level only, top 50 by count, tokenise template on spaces, merge when token counts are equal and ≤ 2 tokens differ; loser folds into the winner (higher count); a differing token becomes the placeholder if either side has one, else `<*>`), `src/types.ts` (`ClusterOptions.fuzzy`), `src/cli.ts` + `src/index.ts` (`--fuzzy` flag), `test/features.test.ts` · accept: `cluster(['ERROR job alpha failed', 'ERROR job beta failed', 'ERROR job alpha failed'], { fuzzy: true })` → 1 signature, `count === 3`, `template === 'job <*> failed'`; without `fuzzy` → 2 signatures · decide: opt-in `--fuzzy` (default off) so existing digests and the `--tokens` test (40 templates one token apart) stay unchanged.
- [x] Short hex ids (6–11 chars: `cafe12` → `cafe<n>` today, near-dupe templates)
  need a heuristic that doesn't eat real words; also `sha256:…` prefixes and
  base64 blobs (`[A-Za-z0-9+/]{20,}={0,2}`) → `<b64>`. → files: `src/mask.ts` (three rules: `sha256:[0-9a-f]{64}` → `<sha>` before the long-hex rule; short hex `\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,11}\b` → `<hex>` right after the long-hex rule (needs ≥ 1 digit AND ≥ 1 letter so `facade`/`decade` survive); base64 `(?<![\w+/=])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{20,}={0,2}(?![\w+/=])` → `<b64>` after `<hex>`, before `<n>`), `test/cluster.test.ts` (extend 'masks uuids, hex ids…') · accept: `mask('img sha256:' + 'a'.repeat(64)) === 'img <sha>'`; `mask('tok cafe12 word facade') === 'tok <hex> word facade'`; `mask('blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz') === 'blob <b64>'`; every existing mask test still passes · decide: `<sha>` covers the `sha256:` prefix form only; bare 64-hex already lands in `<hex>`.
- [x] Timestamps in the middle of a message (`at 2026-08-16T09:14…`) → `<ts>`. → files: `src/mask.ts` (rule before `<n>`: ISO datetime `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?` → `<ts>`), `test/cluster.test.ts` · accept: `mask('token expired at 2026-08-16T09:14:02Z, retry') === 'token expired at <ts>, retry'`; 'masks ipv6 but not clock times' still passes (bare `09:14:02` stays `<n>:<n>:<n>`) · decide: date-time only; bare dates and clock times untouched.

Output
- [x] `--wide` / `--no-sample`: agents want compact; humans sometimes want the
  sample line unclipped. → files: `src/cli.ts` (`Flags.wide`, `Flags.noSample`), `src/types.ts` (`ClusterOptions.wide`), `src/cluster.ts` (sample cap 300 → 2000 chars when `wide`; template cap unchanged), `src/render.ts` (`RenderOptions.noSample` → layout `samples: 'none'`), `src/index.ts` (`renderOpts`/`clusterOpts`), `test/features.test.ts` · accept: `parseArgs(argv('--wide', '--no-sample'))` sets both flags; `renderText(await cluster(LOG), { top: 20, noSample: true })` contains no `↳` line; `(await cluster(['ERROR ' + 'x'.repeat(500)], { wide: true })).signatures[0].sample.length === 500` · decide: `--wide` = longer sample cap only; `--no-sample` drops all `↳` lines, `⤷` detail stays.
- [x] Stable signature ids (short hash of `level+template`) in text and JSON —
  lets diff/snap reference them and lets an agent say "show me #a3f". → files: `src/cluster.ts` (`sigId(level, template)` = sha1 of `` `${level} ${template}` `` sliced to 4 hex chars; set `sig.id` at creation), `src/types.ts` (`Signature.id`), `src/render.ts` (text row `[ERROR] #a3f1 ×312 …`; JSON keeps `id`), `src/diff.ts` (inherits via `renderText`; `gone[]`/`changes[]` carry `id`), `src/snap.ts` (store `id` too), README `--json` schema, `test/features.test.ts` + `test/cluster.test.ts` (update regexes that assert `] ×` / `] +×`) · accept: `sigId('ERROR', 'x')` matches `/^[0-9a-f]{4}$/` and is identical across calls; `renderText(await cluster(LOG), { top: 20 })` first row matches `/^\[ERROR\] #[0-9a-f]{4} ×3/`; `JSON.parse(renderJson(r, { top: 20 })).signatures[0].id` matches `/^[0-9a-f]{4}$/` · decide: 4 hex chars, always shown, no `--no-id` flag.
- [x] `--show <id>`: dump the raw lines behind one signature (bounded, `--limit`),
  the drill-down step after the digest. → files: `src/cli.ts` (`--show <id>`, `--limit <n>` default 20), `src/types.ts` (`ClusterOptions.show?: string`, `showLimit?: number`; `ClusterResult.shown?: string[]`), `src/cluster.ts` (when `show` is set, compute the id per line before grouping and push the raw line into `shown` until `showLimit`), `src/index.ts` (with `--show`: print `#<id> ×<count> <template>` then the raw lines, skip the digest), `test/features.test.ts` · accept: `const r = await cluster(LOG); const id = r.signatures[0].id; (await cluster(LOG, { show: id, showLimit: 2 })).shown` has length 2 and both lines start with `db timeout`; `squirt file.log --show <id>` prints ≤ `--limit` raw lines · decide: depends on the stable-ids item (do that first); single streaming pass — ids are computable per line.
- [x] Exit code 1 if any ERROR signature present (`--fail-on error`) — turns
  squirt into a CI gate. → files: `src/cli.ts` (`--fail-on <lvl>` via `parseLevel` → `Flags.failOn`), `src/render.ts` (`shouldFail(result, level)` = any signature with `SEVERITY[s.level] <= SEVERITY[level]`), `src/index.ts` (after printing in `digest`/source/`diff` cases: `if (flags.failOn && shouldFail(...)) process.exitCode = 1`), README flags table, `skills/squirt/SKILL.md`, `test/features.test.ts` · accept: `shouldFail(await cluster(['ERROR x']), 'ERROR') === true`; `shouldFail(await cluster(['WARN x']), 'ERROR') === false`; `shouldFail(await cluster(['WARN x']), 'WARN') === true`; `printf 'ERROR a\n' | squirt --fail-on error; echo $?` prints the digest then `1` · decide: digest still printed; exit code 1 (2 stays for usage errors).
- [x] Percentages next to counts (`×2,100 (25%)`) — cheap, orients faster. → files: `src/render.ts` (`renderWith`: after `×${count}` append ` (${pct}%)` with `pct = round(count / result.lines * 100)`, `(<1%)` when it rounds to 0), `test/features.test.ts` + `test/cluster.test.ts` (update regexes that assert `×N` followed by two spaces, incl. the diff `+×2  e` / `×2→×10  b` ones) · accept: `renderText(await cluster(LOG), { top: 20 })` first row matches `/^\[ERROR\] ×3 \(43%\)  09:00/` (3 of 7 lines) · decide: shown in text only, not JSON; diff rows inherit it (`+×30 (4%)`).

Robustness
- [x] Huge single lines (base64 dumps, minified stack) — cap per-line work,
  truncate before masking to keep regexes linear. → files: `src/cluster.ts` (`const MAX_LINE = 4000`; after the ANSI strip: `if (raw.length > MAX_LINE) raw = raw.slice(0, MAX_LINE) + '…'`), `test/cluster.test.ts` · accept: `cluster(['ERROR ' + 'A'.repeat(200_000)])` resolves in < 200 ms (`performance.now()` around it) with `signatures[0].template.length <= 200`; also `cluster(['ERROR ' + 'ab12 '.repeat(50_000)])` < 200 ms · decide: hard cap 4000 chars, no flag; `lines`/`folded` unchanged.
- [x] Non-UTF8 / binary detection: bail with a one-line notice instead of a
  digest of garbage. → files: `src/cluster.ts` (line loop: `if (total <= 1 && raw.includes('\0')) throw new Error('input looks binary (NUL byte in first line) — refusing to digest')`), `test/cluster.test.ts` · accept: `await assert.rejects(cluster(['\0\x01\x02 binary']), /looks binary/)`; `head -c 4096 /bin/ls | squirt; echo $?` prints `squirt: input looks binary…` on stderr and `1` · decide: NUL-in-first-line heuristic only (covers files and stdin alike); no charset sniffing.
- [x] Perf budget test: 1M lines in < N s, memory flat — guard the streaming claim. → files: `test/perf.test.ts` (new: async generator yields 1,000,000 lines from 50 templates × varying ids/ips; asserts wall time < 15 s and `process.memoryUsage().heapUsed` delta < 200 MB; `t.diagnostic('1M lines in <s>s')`), `package.json` (`"test:perf": "tsc -p tsconfig.test.json && node --test test-dist/test/perf.test.js"`), `CLAUDE.md` Commands (one line) · accept: `npm run test:perf` passes and prints the diagnostic; `npm test` runtime unchanged (perf file excluded from its glob) · decide: kept out of `npm test`/snuff (too slow for the Stop hook); run on demand and before tagging a release.

Ecosystem
- [x] `--format claude|md`: fenced markdown block ready to paste; trivial, high → files: `src/cli.ts` (`--format <md|claude>` → `Flags.format`; throws with `--json`), `src/index.ts` (`print`: wrap the text digest in a fenced ```` ```text ```` block), README flags table, `test/features.test.ts` · accept: `parseArgs(argv('--format', 'md')).flags.format === 'md'`; `printf 'ERROR a\n' | squirt --format md` first line is ```` ```text ```` and last is ```` ``` ````; `parseArgs(argv('--format', 'md', '--json'))` throws `/--format/` · decide: `claude` is an alias of `md` (identical output) — kept for the item's wording.
  use.
- [x] Library entry (`import { cluster } from 'squirt'`) with a documented API,
  so it can be embedded in an MCP server / other tools without shelling out. → files: `src/lib.ts` (new, side-effect free: re-export `cluster`, `mask`, `compileMask`, `renderText`, `renderJson`, `filterSignatures`, `diff`, `renderDiffText`, `renderDiffJson`, and the types), `package.json` (`"exports": { ".": "./dist/lib.js" }`, `"types": "./dist/lib.d.ts"`; `bin` stays `dist/index.js`), README ("Library" section, 5-line example), `test/features.test.ts` · accept: test `import * as lib from '../src/lib.js'` and `['cluster', 'diff', 'renderText'].every(k => typeof lib[k] === 'function')`; from a temp dir after `npm link squirt`: `node -e "import('squirt').then(m => console.log(typeof m.cluster))"` prints `function` · decide: `index.ts` keeps `main()`; nothing moves, only re-exports.
- [ ] MCP server wrapper (separate package, may take deps) exposing
  `digest(text)` and `diff(a, b)` — the natural distribution channel for the
  "keep raw logs out of AI context" purpose. → files: new sibling package `~/git/squirt-mcp/` (own `package.json` with dep `@modelcontextprotocol/sdk`, imports the `squirt` library entry — depends on the library item above), `src/server.ts` (tools `digest(text, { top?, level?, tokens? })` and `diff(before, after)` returning the text digest), README (`claude mcp add squirt -- node ~/git/squirt-mcp/dist/server.js`), `test/server.test.ts` (calls the tool handlers directly, no transport) · accept: `digest('ERROR a\nERROR a')` handler returns text starting `1 signatures · 2 lines`; `claude mcp list` shows `squirt` after install · decide: separate repo/package so this repo stays dependency-free; do after the library item.

## Phase 6 — ship the guard (2026-08-16 hub deep-think)
- [x] `squirt init --claude [--global]` — installs the PreToolUse guard that today lives hand-written in `~/.claude/hooks/squirt-guard.sh` (blocks raw `kubectl logs|docker logs|journalctl` unless piped through squirt / narrowed). Same contract as `snuff init --claude` / `brief init`; idempotent merge; `--print` to preview. → files: `src/cli.ts` (command `init`, flags `--claude`, `--global`, `--print`), `src/init.ts` (new: `GUARD_SCRIPT` = the contents of `~/.claude/hooks/squirt-guard.sh` embedded as a string; `mergeGuardHook(settingsText)` idempotent, same shape as `~/git/brief/src/init.ts` `mergeSessionHook` — a PreToolUse `Bash` entry whose command contains `squirt-guard`; `cmdInit({ root, global, print })` writes `<root>/.claude/hooks/squirt-guard.sh` + merges `<root>/.claude/settings.json`; `--print` prints the script + resulting JSON and writes nothing), `src/index.ts` (dispatch), README, `test/features.test.ts` (`root` = mkdtemp — never `~`) · accept: `mergeGuardHook(undefined)` → `changed === true` and parsed JSON has `hooks.PreToolUse[0].matcher === 'Bash'`; applying it again to the result → `changed === false`, identical text; `cmdInit({ root: tmp, print: true })` leaves `tmp` empty; `squirt init --claude --print` prints script + JSON with `~/.claude/settings.json` untouched · decide: `--global` → `~/.claude/{hooks,settings.json}`, default → `./.claude/`; the hand-written script is replaced by the embedded copy once shipped.
- [x] Guard **rewrites** instead of blocking (2026-08-16 deep-think #2; LIVE hand-written in `~/.claude/hooks/squirt-guard.sh` since 2026-08-16 — this item = ship that exact script from `squirt init --claude`) — what: when the raw `kubectl logs|docker logs|journalctl` command has no pipe/redirect, the PreToolUse guard returns `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'allow', updatedInput:{...tool_input, command: cmd + ' | squirt'}}}` (verified hook API; whole input object) and only blocks (exit 2) when a rewrite is unsafe (already piped elsewhere, `-f`/`--follow`, `> file`); why: a block is a wasted round-trip and today's guard produced retries, not fewer dumps; → files: `src/init.ts` (`GUARD_SCRIPT` — needs `jq`; emit the JSON on stdout, exit 0), `test/init.test.ts` (run the script with fixture stdin) · accept: stdin `{tool_input:{command:'kubectl logs pod/x'}}` → stdout JSON with `updatedInput.command === 'kubectl logs pod/x | squirt'`; `kubectl logs -f pod/x` → exit 2 with the hint; `kubectl logs pod/x | head` → exit 0, no stdout. decide: ownership stays here (`squirt init --claude`) until tally's `hooks --install` absorbs it — then this script becomes `tally hook pre-bash`'s squirt rule and `squirt init` prints `guard managed by tally hooks`.
- [x] Guard telemetry: count blocks (marker file) so `tally` can show "log dumps prevented" next to "raw log dumps". → files: `src/init.ts` (`GUARD_SCRIPT`: right before `exit 2` append `$(date -u +%FT%TZ) $CMD` as one line to `${SQUIRT_HOME:-$HOME/.squirt}/guard.log`), `src/cli.ts` + `src/index.ts` (`squirt guard-stats [--since 7d]` prints `N log dumps prevented (7d)`), `src/snap.ts` or new `src/guard.ts` (`guardStats(logText, sinceMs)`), README, `test/features.test.ts` · accept: `guardStats('2026-08-15T10:00:00Z kubectl logs x\n2026-08-01T10:00:00Z docker logs y\n', Date.parse('2026-08-10T00:00:00Z')) === 1`; after one blocked command `wc -l ~/.squirt/guard.log` grows by 1 · decide: format = ISO timestamp, space, command per line at `~/.squirt/guard.log`; the tally-side reader is tally's item, not this one. · 2026-08-17 verify: rewrites are logged too (`<ts> rewrite|block <cmd>`), `guard-stats` splits by kind; legacy kind-less lines count as blocks.

- [x] `--brief` output mode — what: red-only digest, ≤ 10 lines, silent when no ERROR/WARN signatures; why: hooks and `snuff` gates need a line budget; accept: `seq 1 300 | squirt --brief` prints nothing, a fixture with 2 ERROR templates prints ≤ 10 lines, exit code unchanged. → files: `src/cli.ts` (`Flags.brief`; throws with `--json`), `src/render.ts` (`renderBrief(result)`: `filterSignatures` at level WARN, header + signature rows only (no `↳`/`⤷`), hard cap 10 lines incl. header, returns `''` when nothing is visible), `src/index.ts` (`print`: brief → skip `console.log` when empty so no blank line), README flags table, `skills/squirt/SKILL.md`, `test/features.test.ts` · accept: `renderBrief(await cluster(['INFO ok'])) === ''`; `renderBrief(await cluster(LOG)).split('\n').length <= 10` and matches `/^\[ERROR\]/m` and not `/↳/`; `parseArgs(argv('--brief', '--json'))` throws · decide: `--brief` implies `--level warn`; `--top` still caps rows below the 10-line ceiling.

## Phase 7 — fleet joins (2026-08-16 hub deep-think #2, ranked)
- [x] **Library entry moves up: snuff is the first consumer** — snuff's "squirt as the fallback trimmer" item imports `cluster`/`renderText` for >200-line gate failures. Do the Phase 5 "Library entry" item next (before the MCP wrapper): `src/lib.ts` side-effect free, `exports` map in package.json, `RenderOptions.maxLines` so a caller can cap by lines as well as `--tokens`, tag `v0.x` so snuff can pin `github:atre/squirt#v0.x`. accept: `node -e "import('squirt').then(m=>console.log(Object.keys(m)))"` from another dir lists `cluster, renderText, diff`; no stdout side effects on import.
- [x] `squirt diff --json` in the fleet Finding shape — what: `findings: [{id: 'log:<sig-id>', scope: 'log', severity: level→crit for ERROR/FATAL, warn for WARN, title: '<template ≤ 80> ×<count> (new since <snap>)', detail: <sample>, hint: 'squirt --show <sig-id>'}]` next to the existing diff output; why: `/ship` step 2 (`pulse diff`) and a future `pulse` "post-deploy logs" probe fold new ERROR signatures in without a squirt-specific parser; needs the "Stable signature ids" item (do it first); → files: `src/diff.ts` (`toFindings`), `src/render.ts` (`renderDiffJson`), README schema note, `test/diff.test.ts` · accept: diff with one new ERROR signature → one crit finding with id `log:<4-hex>`; no new signatures → `findings: []`.

## Fleet review 2026-08-17 (hub TOOLS.md Round 4) — this section is the queue

Verdict: **BUILT, NOT USED** (0 real invocations / 30d, `~/.squirt/guard.log` 0 B, FEEDBACK 0 use-sections). Sunset watch 2026-09-15: survives as the guard payload + library, not as a CLI people type.
- [ ] **One log guard — hand rewriting to tally** — unwire `~/.claude/hooks/squirt-guard.sh` from `~/.claude/settings.json` (tally `hook pre-bash` already rewrites `kubectl logs|docker logs|journalctl|tail -n 300|cat *.log` → `| squirt` and has the fired data); `squirt init --claude` prints "global log guard is owned by `tally hooks --install`" and only ships the per-repo skill; `guard-stats` reads `~/.tally/guard.log` (or is removed). why: two rewriters per Bash call, one never fires · accept: after `tally hooks --install --global`, `tally hooks --list --global` shows one Bash rewriter; `squirt init --claude --global` makes no settings change. `dup → merge`
- [ ] **Push tag `v0.3.0`** so snuff can pin `github:atre/squirt#v0.3.0` (W.8 there). `hygiene`
- [ ] **CLAUDE.md:35 "NO runtime npm dependencies"** contradicts line 9 → align with hub contract. `hygiene`
Parked: MCP server wrapper (no consumer). Keep: library entry (snuff W.8 is its first consumer), `--brief`, `diff --json findings[]` (consumer: `/ship` step 2 — 0 runs yet).

## Non-goals

- Not a log store or shipper — one-shot compression only.
- No daemon, no config file required.
