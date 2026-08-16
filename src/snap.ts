import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { VERSION } from './cli.js';
import type { ClusterResult, Signature } from './types.js';

export interface Snapshot {
  squirt: string;
  name: string;
  scope: string;
  savedAt: string;
  lines: number;
  signatures: Pick<Signature, 'template' | 'level' | 'count'>[];
}

const NAME_RE = /^[\w.-]{1,64}$/;

/** `~/.squirt/<scope-tail>-<hash8>/<name>.json`; `SQUIRT_HOME` overrides the root. */
export function snapPath(name: string, scope: string): string {
  if (!NAME_RE.test(name)) throw new Error(`snapshot name must match ${NAME_RE}, got ${JSON.stringify(name)}`);
  const root = process.env.SQUIRT_HOME || join(homedir(), '.squirt');
  const tail = (basename(scope) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const hash = createHash('sha1').update(scope).digest('hex').slice(0, 8);
  return join(root, `${tail}-${hash}`, `${name}.json`);
}

export function defaultScope(): string {
  return process.cwd();
}

export async function saveSnapshot(name: string, scope: string, result: ClusterResult): Promise<string> {
  const path = snapPath(name, scope);
  const snap: Snapshot = {
    squirt: VERSION,
    name,
    scope,
    savedAt: new Date().toISOString(),
    lines: result.lines,
    signatures: result.signatures.map(({ template, level, count }) => ({ template, level, count })),
  };
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(snap, null, 2)}\n`);
  return path;
}

export async function loadSnapshot(name: string, scope: string): Promise<Snapshot | undefined> {
  const path = snapPath(name, scope);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text) as Snapshot;
}
