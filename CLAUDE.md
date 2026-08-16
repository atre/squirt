# squirt

Log triage compressor: cluster raw logs into a compact signature digest
(template ×count, severity, first/last-seen). Exists to keep raw logs out of
AI-session context — the digest IS the product; guard its compactness.

## Stack
- TypeScript 5.x, Node ≥ 20, ESM only (`"type": "module"`)
- Zero runtime npm deps — built-ins only (hard constraint)
- devDeps: typescript, @types/node

## Commands
- `npm run build` — tsc → dist/
- `npm run dev` — tsc --watch
- `npm test` — compile → test-dist/, run node --test
- `npm run lint` — tsc --noEmit

## Architecture
- `src/index.ts` — entry: subcommand dispatch (digest | diff | snap | k8s | docker | journal)
- `src/cli.ts` — arg parsing, help (no deps, hand-rolled); source commands forward unknown args
- `src/mask.ts` — variable-masking rules (ORDER MATTERS: uuid before hex before number); `--mask` extras run first
- `src/cluster.ts` — timestamp/level extraction, continuation folding, grouping, time histogram
- `src/render.ts` — text digest + JSON; `--level/--grep` filter, sparkline, `--tokens` budget
- `src/diff.ts` — baseline diff (new / grown ≥3× / gone) + its renderers
- `src/snap.ts` — snapshot save/load under `~/.squirt` (`SQUIRT_HOME`)
- `src/sources.ts` — spawn kubectl/docker/journalctl and stream lines
- `src/types.ts` — shared types
- `skills/squirt/SKILL.md` — Claude Code skill (distribution); keep in sync with flags

## Rules
- NO runtime npm dependencies
- Default text output must stay a digest — ~top 20 signatures, never raw lines
  beyond the one `↳ sample` per signature
- New mask rules: append in specificity order, add a case to the mask test
- Roadmap lives in PLAN.md — check it before proposing features
