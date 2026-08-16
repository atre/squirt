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

export type Command = 'digest' | 'diff' | 'snap' | 'k8s' | 'docker' | 'journal';
const COMMANDS: Command[] = ['diff', 'snap', 'k8s', 'docker', 'journal'];

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
  const flags: Flags = { json: false, top: 20, help: false, version: false, sample: 1, mask: [], merge: false };
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
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (isSource) passthrough.push(a);
    else if (a === '-') files.push(a);
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else files.push(a);
  }
  for (const k of ['level', 'grep', 'scope'] as const) {
    if (k in flags && flags[k] === undefined) throw new Error(`--${k} expects a value`);
  }
  if (flags.mask.includes('')) throw new Error('--mask expects a regex');
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
  -h, --help      this help
  -v, --version   version

Examples:
  kubectl logs -n scrap deploy/scraper --since=1h | squirt
  docker logs api 2>&1 | squirt --json --level warn
  squirt /var/log/app.log --top 10 --tokens 800
  squirt snap pre-deploy < before.log; squirt diff pre-deploy < after.log`);
}

export function printVersion(): void {
  console.log(VERSION);
}
