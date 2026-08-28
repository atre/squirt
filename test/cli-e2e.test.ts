import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../src/index.js', import.meta.url));

function run(
  args: string[],
  input = '',
  env?: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : undefined,
  });
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

// ── feedback round 2026-08-23 ──────────────────────────────────────────

test('e2e: --show with an unknown id explains that ids are ephemeral', () => {
  const r = run(['--show', 'ffff'], 'ERROR a\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no signature with id "ffff"/);
  assert.match(r.stderr, /re-run the same pipeline/);
});

test('e2e: init --print points the guard at tally and stays hook-free', () => {
  const r = run(['init', '--claude', '--print']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /tally hooks --install/);
  assert.doesNotMatch(r.stdout, /PreToolUse/);
});

test('e2e: guard-stats reads tally guard.log (TALLY_HOME override)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'squirt-gs-'));
  try {
    await writeFile(
      join(tmp, 'guard.log'),
      '2026-08-22T10:00:00.000Z pre-bash rewritten\n2026-08-22T10:01:00.000Z pre-read rewritten\n',
    );
    const r = run(['guard-stats', '--since', '3650d'], '', { TALLY_HOME: tmp });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^1 log dumps prevented \(3650d\) — 1 rewritten, 0 blocked — via tally pre-bash/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: guard-stats says where the log should be when tally has none', () => {
  const r = run(['guard-stats'], '', { TALLY_HOME: '/tmp/squirt-e2e-empty-home-does-not-exist' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^no guard log at .*squirt-e2e-empty-home-does-not-exist/);
});

test('e2e: --level warn surfaces Jest/Lambda/LogResult signals that fold into OTHER today', () => {
  // Mirrors squirt/FEEDBACK.md 2026-08-26: a CodeBuild integ-test log with a
  // Jest failure summary, an `aws --output text` line embedding a Lambda
  // error JSON, and a `--log-type Tail` LogResult record.
  const tail = [
    'START RequestId: abc Version: $LATEST',
    'ERROR Invoke Error {"errorType":"Error","errorMessage":"boom"}',
    'END RequestId: abc',
  ].join('\n');
  const b64 = Buffer.from(tail, 'utf8').toString('base64');
  const longPrefix = `i-0abc\t2026-08-26T10:00:00Z\t${'x'.repeat(150)}\t`;
  const input =
    [
      'Tests:       1 failed, 4 passed, 5 total',
      `${longPrefix}{"errorType":"Runtime.HandlerError","errorMessage":"Cannot find module"}`,
      `{"LogResult":"${b64}"}`,
    ].join('\n') + '\n';

  const r = run(['--level', 'warn'], input);
  assert.match(r.stdout, /Tests:\s+1 failed/);
  assert.match(r.stdout, /Runtime\.HandlerError: Cannot find module/);
  assert.match(r.stdout, /\[LogResult\] .*Invoke Error/);
});
