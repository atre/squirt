import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../src/index.js', import.meta.url));

function run(args: string[], input = ''): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const LOG = '2026-08-16T09:00:00Z ERROR db timeout\n2026-08-16T09:00:10Z ERROR db timeout\nERROR db timeout\nWARN slow\n';

test('e2e: --fail-on exits 1 only when the threshold is met', () => {
  const errored = run(['--fail-on', 'error'], LOG);
  assert.equal(errored.status, 1);
  assert.match(errored.stdout, /ERROR/);

  const clean = run(['--fail-on', 'error'], 'INFO ok\n');
  assert.equal(clean.status, 0);
});

test('e2e: --format wraps the digest in a fenced block', () => {
  const r = run(['--format', 'md'], 'ERROR a\n');
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], '```text');
  assert.equal(lines[lines.length - 2], '```');
});

test('e2e: --brief is silent below warn and stays ≤10 lines', () => {
  const quiet = run(['--brief'], 'INFO a\nDEBUG b\n');
  assert.equal(quiet.stdout, '');
  const seq = Array.from({ length: 300 }, (_, i) => `INFO line ${i}`).join('\n');
  assert.equal(run(['--brief'], seq).stdout, '');
});

test('e2e: --show dumps raw lines behind a signature id', () => {
  const digest = run([], LOG);
  const id = /#([0-9a-f]{4})/.exec(digest.stdout)![1];
  const shown = run(['--show', id, '--limit', '2'], LOG);
  assert.match(shown.stdout, /^#[0-9a-f]{4} ×3 db timeout\n/);
  assert.equal(shown.stdout.trim().split('\n').length, 3); // header + 2 raw lines (limit)
});

test('e2e: guard-stats reports 0 with no guard.log', () => {
  const r = spawnSync(process.execPath, [BIN, 'guard-stats'], {
    encoding: 'utf8',
    env: { ...process.env, SQUIRT_HOME: '/tmp/squirt-e2e-empty-home-does-not-exist' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^0 log dumps prevented \(7d\)/);
});
