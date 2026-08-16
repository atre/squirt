import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import type { Command } from './cli.js';

interface Spec {
  bin: string;
  argv: string[];
}

const has = (args: string[], ...flags: string[]): boolean =>
  args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));

// Build the CLI incantation. User args are forwarded verbatim; we only add
// the flags that make the output digestible (timestamps, pod prefixes).
export function sourceSpec(command: Command, args: string[]): Spec {
  switch (command) {
    case 'k8s': {
      const argv = ['logs', ...args];
      if (!has(args, '--timestamps')) argv.push('--timestamps');
      if (!has(args, '--prefix')) argv.push('--prefix');
      if (!has(args, '--all-containers', '-c', '--container')) argv.push('--all-containers=true');
      return { bin: 'kubectl', argv };
    }
    case 'docker': {
      const argv = ['logs', ...args];
      if (!has(args, '-t', '--timestamps')) argv.push('--timestamps');
      return { bin: 'docker', argv };
    }
    case 'journal': {
      // First bare arg is the unit: `squirt journal nginx` → journalctl -u nginx.
      const rest = [...args];
      const unit = rest.length && !rest[0].startsWith('-') ? rest.shift() : undefined;
      const argv = ['--no-pager', ...rest];
      if (unit) argv.push('-u', unit);
      if (!has(rest, '-o', '--output')) argv.push('-o', 'short-iso');
      return { bin: 'journalctl', argv };
    }
    default:
      throw new Error(`not a source command: ${command}`);
  }
}

/** Run the source tool and stream its output line by line. */
export async function* streamSource(command: Command, args: string[]): AsyncIterable<string> {
  const { bin, argv } = sourceSpec(command, args);
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const spawnError = new Promise<Error | undefined>((resolve) => {
    child.once('error', (e: NodeJS.ErrnoException) =>
      resolve(e.code === 'ENOENT' ? new Error(`${bin} not found on PATH`) : e),
    );
    child.once('spawn', () => resolve(undefined));
  });
  const exit = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));

  // Keep a stderr tail for the error message. docker: container stderr is log
  // output too — also merge it into the stream (docker frames chunks per line).
  const stderrTail: string[] = [];
  child.stderr.on('data', (d: Buffer) => {
    stderrTail.push(d.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });
  let input: NodeJS.ReadableStream = child.stdout;
  if (command === 'docker') {
    const merged = new PassThrough();
    let open = 2;
    const done = (): void => {
      if (--open === 0) merged.end();
    };
    for (const s of [child.stdout, child.stderr]) {
      s.pipe(merged, { end: false });
      s.once('end', done);
    }
    input = merged;
  }

  const early = await spawnError;
  if (early) throw early;

  yield* createInterface({ input, crlfDelay: Infinity });

  const code = await exit;
  if (code !== 0) {
    const msg = stderrTail.join('').trim().split('\n').slice(-3).join('\n');
    throw new Error(`${bin} ${argv.join(' ')} exited ${code}${msg ? `\n${msg}` : ''}`);
  }
}
