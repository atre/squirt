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

export interface Flags {
  json: boolean;
  top: number;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): { files: string[]; flags: Flags } {
  const files: string[] = [];
  const flags: Flags = { json: false, top: 20, help: false, version: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--top') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--top expects a positive integer');
      flags.top = n;
    } else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '-') files.push(a);
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else files.push(a);
  }
  return { files, flags };
}

export function printHelp(): void {
  console.log(`squirt ${VERSION} — log triage compressor

Cluster raw logs into a compact signature digest: unique message templates
with counts, severity, and first/last-seen — instead of thousands of lines.

Usage:
  squirt [flags] <file...>        digest one or more log files
  <producer> | squirt [flags]     digest stdin

Flags:
  --json        machine-readable output
  --top <n>     max signatures to show (default 20)
  -h, --help    this help
  -v, --version version

Examples:
  kubectl logs -n scrap deploy/scraper --since=1h | squirt
  docker logs api 2>&1 | squirt --json
  squirt /var/log/app.log --top 10`);
}

export function printVersion(): void {
  console.log(VERSION);
}
