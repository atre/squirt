import { createRequire } from 'node:module';

// Single source of truth: package.json (shipped with the package). Resolved
// relative to this file so it works from dist/ and test-dist/src/ alike.
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      return (require(rel) as { version: string }).version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();

export type Command = 'digest' | 'diff' | 'snap' | 'k8s' | 'docker' | 'journal' | 'init' | 'guard-stats';
const COMMANDS: Command[] = ['diff', 'snap', 'k8s', 'docker', 'journal', 'init', 'guard-stats'];

export interface Flags {
  json: boolean;
  top: number;
  help: boolean;
  version: boolean;
  level?: string;
  grep?: string;
  sample: number;
  tokens?: number;
  mask: string[];
  merge: boolean;
  scope?: string;
  wide: boolean;
  noSample: boolean;
  fuzzy: boolean;
  show?: string;
  limit: number;
  causes: number;
  failOn?: string;
  format?: string;
  brief: boolean;
  claude: boolean;
  global: boolean;
  print: boolean;
  since?: string;
}

export interface ParsedArgs {
  command: Command;
  /** Positional args: files for digest; before/after or name for diff; name for snap. */
  files: string[];
  /** For source commands: everything not a squirt flag, forwarded to the tool verbatim. */
  passthrough: string[];
  flags: Flags;
}

function intFlag(name: string, v: string | undefined, min = 1): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} expects an integer ≥ ${min}`);
  return n;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const files: string[] = [];
  const passthrough: string[] = [];
  const flags: Flags = {
    json: false,
    top: 20,
    help: false,
    version: false,
    sample: 1,
    mask: [],
    merge: false,
    wide: false,
    noSample: false,
    fuzzy: false,
    limit: 20,
    causes: 1,
    brief: false,
    claude: false,
    global: false,
    print: false,
  };
  const args = argv.slice(2);
  let command: Command = 'digest';
  if (args.length && (COMMANDS as string[]).includes(args[0])) command = args.shift() as Command;
  const isSource = command === 'k8s' || command === 'docker' || command === 'journal';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--top') flags.top = intFlag('--top', args[++i]);
    else if (a === '--level') flags.level = args[++i];
    else if (a === '--grep') flags.grep = args[++i];
    else if (a === '--sample') flags.sample = intFlag('--sample', args[++i]);
    else if (a === '--tokens') flags.tokens = intFlag('--tokens', args[++i], 20);
    else if (a === '--mask') flags.mask.push(args[++i] ?? '');
    else if (a === '--merge') flags.merge = true;
    else if (a === '--scope') flags.scope = args[++i];
    else if (a === '--wide') flags.wide = true;
    else if (a === '--no-sample') flags.noSample = true;
    else if (a === '--fuzzy') flags.fuzzy = true;
    else if (a === '--show') flags.show = args[++i];
    else if (a === '--limit') flags.limit = intFlag('--limit', args[++i]);
    else if (a === '--causes') flags.causes = Math.min(20, Math.max(1, intFlag('--causes', args[++i])));
    else if (a === '--fail-on') flags.failOn = args[++i];
    else if (a === '--format') flags.format = args[++i];
    else if (a === '--brief') flags.brief = true;
    else if (a === '--claude') flags.claude = true;
    else if (a === '--global') flags.global = true;
    else if (a === '--print') flags.print = true;
    else if (a === '--since' && command === 'guard-stats') flags.since = args[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (isSource) passthrough.push(a);
    else if (a === '-') files.push(a);
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else files.push(a);
  }
  for (const k of ['level', 'grep', 'scope', 'show', 'failOn', 'format', 'since'] as const) {
    if (k in flags && flags[k] === undefined) throw new Error(`--${k} expects a value`);
  }
  if (flags.mask.includes('')) throw new Error('--mask expects a regex');
  if (flags.format && !['md', 'claude'].includes(flags.format)) throw new Error(`--format expects md|claude, got ${flags.format}`);
  if (flags.format && flags.json) throw new Error('--format cannot be combined with --json');
  if (flags.brief && flags.json) throw new Error('--brief cannot be combined with --json');
  return { command, files, passthrough, flags };
}

export function printHelp(): void {
  console.log(`squirt ${VERSION} — log triage compressor

Cluster raw logs into a compact signature digest: unique message templates
with counts, severity, sparkline and first/last-seen — instead of thousands
of lines. Built to keep raw logs out of AI-session context.

Usage:
  squirt [flags] <file...>              digest files ("-" = stdin, mixable)
  <producer> | squirt [flags]           digest stdin
  squirt diff <before> <after>          signatures new/grown in <after>
  squirt snap <name> [file...]          digest + save signature set as baseline
  squirt diff <name> [file...]          digest input, show what's new vs snapshot
  squirt k8s <kubectl logs args>        e.g. squirt k8s -n prod deploy/api --since 1h
  squirt docker <docker logs args>      e.g. squirt docker api --since 1h
  squirt journal <unit|journalctl args> e.g. squirt journal nginx --since -1h
  squirt init --claude [--global]       install the squirt skill (log guard is owned by tally)
  squirt guard-stats [--since 7d]       log dumps prevented, read from tally's guard.log

Flags:
  --json          machine-readable output (schema: see README)
  --top <n>       max signatures to show (default 20)
  --level <lvl>   minimum severity: error|warn|other|info|debug
  --grep <re>     only signatures whose template/sample matches
  --sample <n>    keep up to n distinct samples for ERROR signatures
  --tokens <n>    shrink the digest to fit ~n tokens (chars/4)
  --mask <re>     extra masking rule (repeatable); matches become <mask>
  --merge         tag samples with the source file when digesting many files
  --scope <s>     snapshot scope for snap/diff (default: cwd)
  --wide          longer sample lines (2000 chars instead of 300)
  --no-sample     drop the ↳ sample line (⤷ detail still shows)
  --fuzzy         merge near-duplicate templates (≤2 tokens differ)
  --show <id>     dump raw lines behind one signature id (see --limit)
  --limit <n>     max raw lines for --show (default 20)
  --causes <n>    keep up to n cause lines per signature (default 1)
  --fail-on <lvl> exit 1 if any signature is at this severity or worse
  --format <fmt>  wrap text output: md (fenced block) or claude (alias)
  --brief         red-only digest, ≤10 lines, silent when nothing at warn+
  -h, --help      this help
  -v, --version   version

Examples:
  kubectl logs -n myapp deploy/api --since=1h | squirt
  docker logs api 2>&1 | squirt --json --level warn
  squirt /var/log/app.log --top 10 --tokens 800
  squirt snap pre-deploy < before.log; squirt diff pre-deploy < after.log`);
}

export function printVersion(): void {
  console.log(VERSION);
}
