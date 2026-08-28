import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POINTER =
  'squirt: the global log guard is owned by tally — run `tally hooks --install --global`. squirt init only installs the squirt skill.';

/** Locate the packaged SKILL.md relative to the compiled module (dist/ or test-dist/src/). */
function skillSource(): string {
  for (const rel of ['../skills/squirt/SKILL.md', '../../skills/squirt/SKILL.md']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  throw new Error('squirt: packaged skills/squirt/SKILL.md not found');
}

export interface InitOptions {
  root: string;
  global?: boolean;
  print?: boolean;
}

/** `squirt init --claude [--global] [--print]`: install the squirt skill. Returns the exit code. */
export function cmdInit(opts: InitOptions): number {
  const base = opts.global ? join(homedir(), '.claude') : join(opts.root, '.claude');
  const target = join(base, 'skills', 'squirt', 'SKILL.md');
  const content = readFileSync(skillSource(), 'utf8');
  console.log(POINTER);
  if (opts.print) {
    console.log(`would write ${target}`);
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
  return 0;
}
