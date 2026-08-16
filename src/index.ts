#!/usr/bin/env node

import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, printHelp, printVersion, type Flags } from './cli.js';
import { cluster } from './cluster.js';
import { diff, renderDiffJson, renderDiffText, type Baseline } from './diff.js';
import { guardStats, parseDuration } from './guard.js';
import { cmdInit } from './init.js';
import { compileMask } from './mask.js';
import { parseLevel, renderBrief, renderJson, renderText, shouldFail, type RenderOptions } from './render.js';
import { defaultScope, loadSnapshot, saveSnapshot } from './snap.js';
import { streamSource } from './sources.js';
import type { ClusterOptions, ClusterResult, TaggedLine } from './types.js';

// Stream lines from every input in order — never buffer the whole firehose.
// "-" means stdin, consumed in argv order alongside files; it can appear once.
async function* readLines(files: string[], merge = false): AsyncIterable<string | TaggedLine> {
  const sources = files.length > 0 ? files : ['-'];
  if (sources.filter((f) => f === '-').length > 1) throw new Error("stdin ('-') given more than once");
  const tag = merge && sources.length > 1;
  for (const f of sources) {
    const input = f === '-' ? process.stdin : createReadStream(f, 'utf8');
    const rl = createInterface({ input, crlfDelay: Infinity });
    if (!tag) yield* rl;
    else {
      const source = f === '-' ? 'stdin' : basename(f);
      for await (const text of rl) yield { text, source };
    }
  }
}

function renderOpts(flags: Flags): RenderOptions {
  return {
    top: flags.top,
    level: flags.level ? parseLevel(flags.level) : undefined,
    grep: flags.grep ? new RegExp(flags.grep) : undefined,
    tokens: flags.tokens,
    noSample: flags.noSample,
  };
}

function clusterOpts(flags: Flags): ClusterOptions {
  return {
    masks: flags.mask.map(compileMask),
    samples: flags.sample,
    wide: flags.wide,
    fuzzy: flags.fuzzy,
    show: flags.show,
    showLimit: flags.limit,
  };
}

const noStdin = (files: string[]): boolean => files.length === 0 && Boolean(process.stdin.isTTY);

async function main(): Promise<void> {
  const { command, files, passthrough, flags } = parseArgs(process.argv);

  if (flags.help) return printHelp();
  if (flags.version) return printVersion();

  if (command === 'init') {
    process.exitCode = cmdInit({ root: process.cwd(), global: flags.global, print: flags.print });
    return;
  }

  if (command === 'guard-stats') {
    const home = process.env.SQUIRT_HOME || join(homedir(), '.squirt');
    const logPath = join(home, 'guard.log');
    const text = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
    const since = flags.since ?? '7d';
    const n = guardStats(text, Date.now() - parseDuration(since));
    console.log(`${n} log dumps prevented (${since})`);
    return;
  }

  const ropts = renderOpts(flags);
  const copts = clusterOpts(flags);
  const digest = async (input: AsyncIterable<string | TaggedLine>): Promise<ClusterResult> => cluster(input, copts);
  const print = (result: ClusterResult): void => {
    if (flags.show) {
      const sig = result.signatures.find((s) => s.id === flags.show);
      if (!sig) {
        console.error(`squirt: no signature with id ${JSON.stringify(flags.show)}`);
        process.exitCode = 1;
        return;
      }
      console.log(`#${sig.id} ×${sig.count} ${sig.template}`);
      for (const line of result.shown ?? []) console.log(line);
      return;
    }
    if (flags.brief) {
      const brief = renderBrief(result);
      if (brief) console.log(brief);
    } else if (flags.json) {
      console.log(renderJson(result, ropts));
    } else if (flags.format) {
      console.log(`\`\`\`text\n${renderText(result, ropts)}\n\`\`\``);
    } else {
      console.log(renderText(result, ropts));
    }
    if (flags.failOn && shouldFail(result, parseLevel(flags.failOn))) process.exitCode = 1;
  };

  switch (command) {
    case 'digest': {
      if (noStdin(files)) {
        printHelp();
        process.exitCode = 1;
        return;
      }
      return print(await digest(readLines(files, flags.merge)));
    }

    case 'k8s':
    case 'docker':
    case 'journal':
      return print(await digest(streamSource(command, passthrough)));

    case 'snap': {
      const [name, ...rest] = files;
      if (!name) throw new Error('usage: squirt snap <name> [file...]');
      if (noStdin(rest)) throw new Error('squirt snap: no input (pipe logs in or pass files)');
      const result = await digest(readLines(rest, flags.merge));
      const path = await saveSnapshot(name, flags.scope ?? defaultScope(), result);
      print(result);
      console.error(`squirt: saved ${result.signatures.length} signatures → ${path}`);
      return;
    }

    case 'diff': {
      const [a, ...rest] = files;
      if (!a) throw new Error('usage: squirt diff <before> <after> | squirt diff <name> [file...]');
      let baseline: Baseline;
      let label: string;
      let afterInput: AsyncIterable<string | TaggedLine>;
      if (existsSync(a) && rest.length === 1 && rest[0] !== '-' && existsSync(rest[0])) {
        // two-file mode: both positionals are files
        baseline = (await digest(readLines([a]))).signatures;
        label = basename(a);
        afterInput = readLines(rest, flags.merge);
      } else if (existsSync(a) && rest.length === 1 && rest[0] === '-') {
        baseline = (await digest(readLines([a]))).signatures;
        label = basename(a);
        afterInput = readLines(['-']);
      } else {
        const scope = flags.scope ?? defaultScope();
        const snap = await loadSnapshot(a, scope);
        if (!snap) {
          throw new Error(
            existsSync(a)
              ? `squirt diff ${a}: second file missing (two-file mode) and no snapshot named ${JSON.stringify(a)} in scope ${scope}`
              : `no snapshot named ${JSON.stringify(a)} in scope ${scope} (create one: squirt snap ${a})`,
          );
        }
        if (noStdin(rest)) throw new Error('squirt diff: no input to compare (pipe logs in or pass files)');
        baseline = snap.signatures;
        label = `snap ${a} @ ${snap.savedAt.slice(0, 16).replace('T', ' ')}`;
        afterInput = readLines(rest, flags.merge);
      }
      const d = diff(baseline, await digest(afterInput));
      console.log(flags.json ? renderDiffJson(d, ropts, label) : renderDiffText(d, ropts, label));
      if (flags.failOn && shouldFail(d.after, parseLevel(flags.failOn))) process.exitCode = 1;
      return;
    }
  }
}

main().catch((err: unknown) => {
  console.error(`squirt: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
