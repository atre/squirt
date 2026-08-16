#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs, printHelp, printVersion } from './cli.js';
import { cluster } from './cluster.js';
import { renderJson, renderText } from './render.js';

// Stream lines from every input in order — never buffer the whole firehose.
async function* readLines(files: string[]): AsyncIterable<string> {
  const sources = files.length > 0 && !files.includes('-') ? files : ['-'];
  for (const f of sources) {
    const input = f === '-' ? process.stdin : createReadStream(f, 'utf8');
    yield* createInterface({ input, crlfDelay: Infinity });
  }
}

async function main(): Promise<void> {
  const { files, flags } = parseArgs(process.argv);

  if (flags.help) return printHelp();
  if (flags.version) return printVersion();

  if (files.length === 0 && process.stdin.isTTY) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const result = await cluster(readLines(files));
  console.log(flags.json ? renderJson(result, flags.top) : renderText(result, flags.top));
}

main().catch((err: unknown) => {
  console.error(`squirt: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
