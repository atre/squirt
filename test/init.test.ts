import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdInit } from '../src/init.js';
import { guardStats, parseDuration } from '../src/guard.js';

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

// ── guard-stats ──────────────────────────────────────────────────────────

test('guardStats counts guard.log entries at or after a cutoff', () => {
  const log = '2026-08-15T10:00:00Z pre-bash rewritten\n2026-08-01T10:00:00Z pre-bash blocked\n';
  assert.deepEqual(guardStats(log, Date.parse('2026-08-10T00:00:00Z')), { total: 1, rewritten: 1, blocked: 0 });
  assert.equal(guardStats('', Date.parse('2026-08-10T00:00:00Z')).total, 0);
});

// ── feedback round 2026-08-23: guard handed to tally, init ships the skill ──

test('guardStats parses tally guard.log format, pre-bash lines only', () => {
  const log =
    '2026-08-22T10:00:00.000Z pre-bash rewritten\n' +
    '2026-08-22T10:01:00.000Z pre-bash blocked\n' +
    '2026-08-22T10:02:00.000Z pre-read rewritten\n';
  assert.deepEqual(guardStats(log, 0), { total: 2, rewritten: 1, blocked: 1 });
});

test('cmdInit installs the squirt skill, never a guard hook or settings edit', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'squirt-init-'));
  try {
    const code = cmdInit({ root: tmp });
    assert.equal(code, 0);
    const skill = await readFile(join(tmp, '.claude', 'skills', 'squirt', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: squirt\n/);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(tmp, '.claude', 'hooks', 'squirt-guard.sh')), false);
    assert.equal(existsSync(join(tmp, '.claude', 'settings.json')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('parseDuration parses <n>[smhd]', () => {
  assert.equal(parseDuration('7d'), 7 * 86_400_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.throws(() => parseDuration('nope'), /--since expects/);
});
