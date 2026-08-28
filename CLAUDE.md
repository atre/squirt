# squirt

Log triage compressor: cluster raw logs into a compact signature digest
(template ×count, severity, first/last-seen). Exists to keep raw logs out of
AI-session context — the digest IS the product; guard its compactness.

## Stack
- TypeScript 5.x, Node ≥ 20, ESM only (`"type": "module"`)
- No runtime npm deps (built-ins only) — hard rule, see Rules below; deps-requiring features go in a sibling package (e.g. the MCP wrapper), not here
- devDeps: typescript, @types/node

## Commands
- `npm run build` — tsc → dist/
- `npm run dev` — tsc --watch
- `npm test` — compile → test-dist/, run node --test (excludes test/perf/)
- `npm run test:perf` — 1M-line streaming budget test (too slow for the Stop hook)
- `npm run lint` — tsc --noEmit

## Architecture
- `src/index.ts` — entry: subcommand dispatch (digest | diff | snap | k8s | docker | journal | init | guard-stats)
- `src/cli.ts` — arg parsing, help (no deps, hand-rolled); source commands forward unknown args
- `src/mask.ts` — variable-masking rules (ORDER MATTERS: uuid before hex before number); `--mask` extras run first
- `src/cluster.ts` — timestamp/level extraction, multi-line JSON/logfmt parsing, continuation folding, grouping, time histogram, stable ids, `--fuzzy` near-dup merge
- `src/render.ts` — text digest + JSON; `--level/--grep` filter, sparkline, `--tokens`/`--maxLines` budget, `--brief`
- `src/diff.ts` — baseline diff (new / grown ≥3× / gone) + its renderers
- `src/snap.ts` — snapshot save/load under `~/.squirt` (`SQUIRT_HOME`)
- `src/sources.ts` — spawn kubectl/docker/journalctl and stream lines
- `src/init.ts` — `squirt init --claude`: installs the squirt skill into `.claude/skills/` (the log-dump guard is owned by `tally hooks --install`)
- `src/guard.ts` — `squirt guard-stats`: reads tally's `~/.tally/guard.log` (pre-bash rewrites/blocks)
- `src/lib.ts` — library entry (`import { cluster } from 'squirt'`), side-effect free
- `src/types.ts` — shared types
- `skills/squirt/SKILL.md` — Claude Code skill (distribution); keep in sync with flags

## Rules
- NO runtime npm dependencies
- Default text output must stay a digest — ~top 20 signatures, never raw lines
  beyond the one `↳ sample` per signature
- New mask rules: append in specificity order, add a case to the mask test
- Roadmap lives in PLAN.md — check it before proposing features

- `snuff` is the definition-of-done gate — run it before declaring work
  done (a Stop hook runs `snuff --hook` automatically).
- Fleet contract + cross-tool backlog: `~/git/hub/TOOLS.md` — read it before
  any release/push work (naming + repo-hygiene rules). PLAN.md and FEEDBACK.md
  are local-only (untracked).
