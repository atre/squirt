import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInit, GUARD_SCRIPT, mergeGuardHook } from '../src/init.js';
import { guardStats, parseDuration } from '../src/guard.js';

test('mergeGuardHook: idempotent, wires a Bash PreToolUse hook', () => {
  const first = mergeGuardHook(undefined);
  assert.equal(first.changed, true);
  const parsed = JSON.parse(first.text);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(parsed.hooks.PreToolUse[0].hooks[0].command, /squirt-guard/);

  const second = mergeGuardHook(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('mergeGuardHook: appends to an existing Bash matcher group instead of duplicating it', () => {
  const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard.sh' }] }] } });
  const merged = mergeGuardHook(existing);
  const parsed = JSON.parse(merged.text);
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.PreToolUse[0].hooks.length, 2);
});

test('cmdInit: --print writes nothing to disk', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'squirt-init-'));
  try {
    const code = cmdInit({ root: tmp, print: true });
    assert.equal(code, 0);
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(tmp));
    assert.deepEqual(entries, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('cmdInit: installs the script and wires settings.json under <root>/.claude', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'squirt-init-'));
  try {
    cmdInit({ root: tmp });
    const script = await readFile(join(tmp, '.claude', 'hooks', 'squirt-guard.sh'), 'utf8');
    assert.equal(script, GUARD_SCRIPT);
    const settings = JSON.parse(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
    // idempotent: running again doesn't duplicate the hook entry
    cmdInit({ root: tmp });
    const settings2 = JSON.parse(await readFile(join(tmp, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings2.hooks.PreToolUse[0].hooks.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the generated guard script is valid bash and rewrites/blocks as designed', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'squirt-guard-'));
  const scriptPath = join(tmp, 'guard.sh');
  try {
    await import('node:fs/promises').then((fs) => fs.writeFile(scriptPath, GUARD_SCRIPT, { mode: 0o755 }));
    assert.doesNotThrow(() => execFileSync('bash', ['-n', scriptPath]));

    // SQUIRT_HOME → tmp so the test never touches the real ~/.squirt/guard.log
    const env = { ...process.env, SQUIRT_HOME: tmp };
    const run = (command: string): string =>
      execFileSync('bash', [scriptPath], { input: JSON.stringify({ tool_input: { command } }), env }).toString();

    assert.equal(JSON.parse(run('kubectl logs pod/x')).hookSpecificOutput.updatedInput.command, 'kubectl logs pod/x | squirt');
    assert.throws(() => run('kubectl logs -f pod/x'));
    assert.equal(run('kubectl logs pod/x | head'), '');

    const log = await import('node:fs/promises').then((fs) => fs.readFile(join(tmp, 'guard.log'), 'utf8'));
    assert.match(log, /Z rewrite kubectl logs pod\/x\n/);
    assert.match(log, /Z block kubectl logs -f pod\/x\n/);
    assert.deepEqual(guardStats(log, 0), { total: 2, rewritten: 1, blocked: 1 });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ── guard-stats ──────────────────────────────────────────────────────────

test('guardStats counts guard.log entries at or after a cutoff', () => {
  const log = '2026-08-15T10:00:00Z kubectl logs x\n2026-08-01T10:00:00Z docker logs y\n';
  // legacy lines (no kind) count as blocks
  assert.deepEqual(guardStats(log, Date.parse('2026-08-10T00:00:00Z')), { total: 1, rewritten: 0, blocked: 1 });
  assert.equal(guardStats('', Date.parse('2026-08-10T00:00:00Z')).total, 0);
});

test('parseDuration parses <n>[smhd]', () => {
  assert.equal(parseDuration('7d'), 7 * 86_400_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.throws(() => parseDuration('nope'), /--since expects/);
});
