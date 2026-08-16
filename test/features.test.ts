import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.js';
import { cluster, toEpoch } from '../src/cluster.js';
import { diff, renderDiffJson, renderDiffText } from '../src/diff.js';
import { compileMask, mask } from '../src/mask.js';
import { filterSignatures, parseLevel, renderJson, renderText, sparkBuckets } from '../src/render.js';
import { loadSnapshot, saveSnapshot, snapPath } from '../src/snap.js';
import { sourceSpec } from '../src/sources.js';

const argv = (...a: string[]): string[] => ['node', 'squirt', ...a];

// ── cli ───────────────────────────────────────────────────────────────

test('cli: subcommands, flags, passthrough for sources', () => {
  const d = parseArgs(argv('a.log', '-', '--top', '5', '--level', 'warn', '--grep', 'x', '--sample', '3', '--tokens', '500', '--mask', 'foo', '--mask', 'bar', '--merge'));
  assert.equal(d.command, 'digest');
  assert.deepEqual(d.files, ['a.log', '-']);
  assert.equal(d.flags.top, 5);
  assert.equal(d.flags.level, 'warn');
  assert.equal(d.flags.grep, 'x');
  assert.equal(d.flags.sample, 3);
  assert.equal(d.flags.tokens, 500);
  assert.deepEqual(d.flags.mask, ['foo', 'bar']);
  assert.equal(d.flags.merge, true);

  const k = parseArgs(argv('k8s', '-n', 'prod', 'deploy/api', '--since', '1h', '--json'));
  assert.equal(k.command, 'k8s');
  assert.deepEqual(k.passthrough, ['-n', 'prod', 'deploy/api', '--since', '1h']);
  assert.equal(k.flags.json, true);

  const s = parseArgs(argv('snap', 'pre', '--scope', 'svc'));
  assert.equal(s.command, 'snap');
  assert.deepEqual(s.files, ['pre']);
  assert.equal(s.flags.scope, 'svc');

  assert.throws(() => parseArgs(argv('--bogus')), /unknown flag/);
  assert.throws(() => parseArgs(argv('--level')), /--level expects a value/);
  assert.throws(() => parseArgs(argv('--tokens', '5')), /--tokens expects/);
});

test('cli: Phase 5/6 flags — wide, no-sample, fuzzy, show, limit, fail-on, format, brief, init, guard-stats', () => {
  const d = parseArgs(argv('--wide', '--no-sample', '--fuzzy', '--show', 'a3f1', '--limit', '5', '--fail-on', 'error', '--format', 'md'));
  assert.equal(d.flags.wide, true);
  assert.equal(d.flags.noSample, true);
  assert.equal(d.flags.fuzzy, true);
  assert.equal(d.flags.show, 'a3f1');
  assert.equal(d.flags.limit, 5);
  assert.equal(d.flags.failOn, 'error');
  assert.equal(d.flags.format, 'md');

  assert.throws(() => parseArgs(argv('--format', 'md', '--json')), /--format/);
  assert.throws(() => parseArgs(argv('--format', 'bogus')), /--format expects/);
  assert.throws(() => parseArgs(argv('--brief', '--json')), /--brief/);

  const i = parseArgs(argv('init', '--claude', '--global', '--print'));
  assert.equal(i.command, 'init');
  assert.equal(i.flags.claude, true);
  assert.equal(i.flags.global, true);
  assert.equal(i.flags.print, true);

  const g = parseArgs(argv('guard-stats', '--since', '7d'));
  assert.equal(g.command, 'guard-stats');
  assert.equal(g.flags.since, '7d');

  // --since is a squirt flag only for guard-stats; source commands still forward it verbatim
  const k = parseArgs(argv('k8s', '-n', 'prod', 'deploy/api', '--since', '1h'));
  assert.deepEqual(k.passthrough, ['-n', 'prod', 'deploy/api', '--since', '1h']);
  assert.equal(k.flags.since, undefined);
});

test('sourceSpec builds the incantations and forwards args verbatim', () => {
  assert.deepEqual(sourceSpec('k8s', ['-n', 'prod', 'deploy/api', '--since', '1h']), {
    bin: 'kubectl',
    argv: ['logs', '-n', 'prod', 'deploy/api', '--since', '1h', '--timestamps', '--prefix', '--all-containers=true'],
  });
  assert.deepEqual(sourceSpec('k8s', ['pod/x', '-c', 'app']).argv, ['logs', 'pod/x', '-c', 'app', '--timestamps', '--prefix']);
  assert.deepEqual(sourceSpec('docker', ['api', '--since', '1h']), { bin: 'docker', argv: ['logs', 'api', '--since', '1h', '--timestamps'] });
  assert.deepEqual(sourceSpec('journal', ['nginx', '--since', '-1h']), {
    bin: 'journalctl',
    argv: ['--no-pager', '--since', '-1h', '-u', 'nginx', '-o', 'short-iso'],
  });
});

// ── render: filters, sparkline, samples, tokens ────────────────────────

const LOG = [
  '2026-08-16T09:00:00Z ERROR db timeout host=10.0.0.1',
  '2026-08-16T09:00:10Z ERROR db timeout host=10.0.0.2',
  '2026-08-16T09:00:20Z ERROR db timeout host=10.0.0.3',
  '2026-08-16T09:00:30Z WARN slow query 900ms',
  '2026-08-16T09:00:40Z INFO served 42 requests',
  '2026-08-16T09:00:50Z DEBUG tick',
  '2026-08-16T09:01:00Z kernel: eth0 up',
];

test('--level and --grep filter signatures; header shows visible/total', async () => {
  const result = await cluster(LOG);
  assert.equal(filterSignatures(result, { top: 20, level: 'WARN' }).visible.map((s) => s.level).join(), 'ERROR,WARN');
  assert.equal(filterSignatures(result, { top: 20, level: 'INFO' }).visible.length, 4); // ERROR WARN OTHER INFO
  assert.equal(filterSignatures(result, { top: 20, grep: /slow/ }).visible.length, 1);
  assert.match(renderText(result, { top: 20, level: 'WARN' }), /^2\/5 signatures · 7 lines/);
  assert.equal(parseLevel('warning'), 'WARN');
  assert.throws(() => parseLevel('loud'), /--level expects/);
});

test('sparkline: bucketed by time across the whole input, doubling widths on long spans', async () => {
  const lines: string[] = [];
  // 100 lines of "a" in the first 100 s, then a burst of "b" at the very end (~1h later)
  for (let i = 0; i < 100; i++) lines.push(`2026-08-16T09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO a`);
  for (let i = 0; i < 20; i++) lines.push(`2026-08-16T10:00:${String(i).padStart(2, '0')}Z ERROR b`);
  const result = await cluster(lines);
  assert.ok(result.time);
  assert.ok(result.time!.bucketMs > 1000, 'bucket width doubled for a 1h span');
  const b = result.signatures.find((s) => s.template === 'b')!;
  const a = result.signatures.find((s) => s.template === 'a')!;
  const bs = sparkBuckets(b, result)!;
  const as = sparkBuckets(a, result)!;
  assert.equal(bs.length, 10);
  assert.equal(bs.reduce((x, y) => x + y, 0), 20);
  assert.equal(bs[9], 20, 'all of b lands in the last bucket');
  assert.equal(as[0], 100, 'all of a lands in the first bucket');
  const text = renderText(result, { top: 20 });
  assert.match(text, /\[ERROR\] #[0-9a-f]{4} ×20 \(17%\)  10:00  ▁▁▁▁▁▁▁▁▁█  b/);
  assert.match(text, /\[INFO\] #[0-9a-f]{4} ×100 \(83%\)  09:00→09:01  █▁▁▁▁▁▁▁▁▁  a/);
  const json = JSON.parse(renderJson(result, { top: 20 }));
  assert.equal(json.time.start, '2026-08-16T09:00:00.000Z');
  assert.deepEqual(json.signatures[0].spark, bs);
  assert.equal(json.signatures[0].hist, undefined);
});

test('no sparkline without timestamps; syslog stamps get the current year', async () => {
  const result = await cluster(['ERROR a', 'ERROR a']);
  assert.equal(result.time, undefined);
  assert.doesNotMatch(renderText(result, { top: 5 }), /[▁█]/);
  assert.equal(new Date(toEpoch('Aug 16 09:18:00')!).getFullYear(), new Date().getFullYear());
  assert.equal(toEpoch('nope'), undefined);
});

test('--sample keeps extra distinct samples for ERROR only', async () => {
  const result = await cluster(
    ['ERROR x id=1', 'ERROR x id=2', 'ERROR x id=2', 'ERROR x id=3', 'ERROR x id=4', 'WARN y id=1', 'WARN y id=2'],
    { samples: 3 },
  );
  const [err, warn] = result.signatures;
  assert.equal(err.sample, 'x id=1');
  assert.deepEqual(err.samples, ['x id=2', 'x id=3']);
  assert.equal(warn.samples, undefined);
  const text = renderText(result, { top: 5 });
  assert.equal(text.split('\n').filter((l) => l.startsWith('  ↳')).length, 4);
});

test('--mask adds user rules ahead of the built-ins', () => {
  assert.equal(mask('job job-abc-42 done', [compileMask('job-[a-z]+-\\d+')]), 'job <mask> done');
  assert.throws(() => compileMask('('), /invalid regex/);
});

test('--merge tags samples with the source; kubectl prefix wins', async () => {
  const result = await cluster([
    { text: 'ERROR boom', source: 'api.log' },
    { text: 'ERROR boom', source: 'web.log' },
    { text: '[pod/api-1/app] ERROR crash', source: 'k.log' },
  ]);
  assert.equal(result.signatures[0].source, 'api.log');
  assert.equal(result.signatures[1].source, 'api-1');
  assert.match(renderText(result, { top: 5 }), /↳ \[api\.log\] boom/);
});

test('--tokens shrinks the digest to the budget', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 3; j++) lines.push(`2026-08-16T09:00:0${j}Z ERROR failure kind${String.fromCharCode(65 + i)} on host-${j}.internal with a rather long message tail ${'x'.repeat(40)}`);
  const result = await cluster(lines);
  const full = renderText(result, { top: 40 });
  const tight = renderText(result, { top: 40, tokens: 300 });
  assert.ok(full.length / 4 > 300);
  assert.ok(tight.length / 4 <= 300, `got ~${tight.length / 4} tokens`);
  assert.match(tight, /\(fit to --tokens 300\)/);
  assert.match(tight, /more signatures \(raise --top\)/);
  // a roomy budget renders the full digest untouched
  assert.equal(renderText(result, { top: 40, tokens: 100000 }), full);
});

test('stable signature ids: 4 hex chars, deterministic, shown in text and json', async () => {
  const result = await cluster(LOG);
  assert.match(result.signatures[0].id, /^[0-9a-f]{4}$/);
  const again = await cluster(LOG);
  assert.equal(again.signatures[0].id, result.signatures[0].id);
  assert.match(renderText(result, { top: 20 }), /^\d+ signatures · \d+ lines\n\[ERROR\] #[0-9a-f]{4} ×3/);
  assert.match(JSON.parse(renderJson(result, { top: 20 })).signatures[0].id, /^[0-9a-f]{4}$/);
});

test('--show dumps the raw lines behind one signature id', async () => {
  const r = await cluster(LOG);
  const id = r.signatures[0].id;
  const shown = (await cluster(LOG, { show: id, showLimit: 2 })).shown!;
  assert.equal(shown.length, 2); // LOG has 3 "db timeout" lines; capped at showLimit
  assert.ok(shown.every((l) => l.startsWith('db timeout')));
});

test('--maxLines shrinks the digest to a line budget, same ladder as --tokens', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) lines.push(`ERROR failure kind${String.fromCharCode(65 + i)}`);
  const result = await cluster(lines);
  const tight = renderText(result, { top: 40, maxLines: 10 });
  assert.ok(tight.split('\n').length <= 10, `got ${tight.split('\n').length} lines`);
  assert.match(tight, /\(fit to 10 lines\)/);
});

test('lib: side-effect-free library entry exposes cluster/diff/renderText', async () => {
  const lib = await import('../src/lib.js');
  for (const k of ['cluster', 'diff', 'renderText'] as const) assert.equal(typeof lib[k], 'function');
});

// ── diff & snap ────────────────────────────────────────────────────────

test('diff: new, grown, gone, unchanged', async () => {
  const before = await cluster(['ERROR a', 'ERROR b', 'ERROR b', 'WARN c', 'INFO d']);
  const after = await cluster(['ERROR a', ...Array(10).fill('ERROR b'), 'WARN c', 'ERROR e', 'ERROR e']);
  const d = diff(before.signatures, after);
  assert.deepEqual(d.entries.map((e) => [e.template, e.change, e.before, e.count]), [
    ['e', 'new', 0, 2],
    ['b', 'grown', 2, 10],
  ]);
  assert.deepEqual(d.gone.map((g) => g.template), ['d']);
  assert.equal(d.unchanged, 2);
  const text = renderDiffText(d, { top: 20 }, 'before.log');
  assert.equal(text.split('\n')[0], '1 new · 1 grown · 1 gone · 2 unchanged  (vs before.log; after: 14 lines)');
  assert.match(text, /\[ERROR\] #[0-9a-f]{4} \+×2 \(14%\)  e/);
  assert.match(text, /\[ERROR\] #[0-9a-f]{4} ×2→×10 \(71%\)  b/);
  const json = JSON.parse(renderDiffJson(d, { top: 20 }, 'before.log'));
  assert.equal(json.changes.length, 2);
  assert.equal(json.gone[0].template, 'd');

  // fleet Finding shape: only "new" signatures at ERROR/WARN produce a finding
  assert.equal(json.findings.length, 1);
  assert.match(json.findings[0].id, /^log:[0-9a-f]{4}$/);
  assert.equal(json.findings[0].scope, 'log');
  assert.equal(json.findings[0].severity, 'crit');
  assert.equal(json.findings[0].title, 'e ×2 (new since before.log)');
  assert.match(json.findings[0].hint, /^squirt --show [0-9a-f]{4}$/);

  const same = diff(before.signatures, before);
  assert.match(renderDiffText(same, { top: 20 }, 'x'), /nothing new\./);
  assert.deepEqual(JSON.parse(renderDiffJson(same, { top: 20 }, 'x')).findings, []);
});

test('snap: save + load under SQUIRT_HOME, scoped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'squirt-'));
  const prev = process.env.SQUIRT_HOME;
  process.env.SQUIRT_HOME = home;
  try {
    const result = await cluster(['ERROR a', 'WARN b']);
    const path = await saveSnapshot('pre', '/my/svc', result);
    assert.equal(path, snapPath('pre', '/my/svc'));
    assert.ok(path.startsWith(home));
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.scope, '/my/svc');
    assert.deepEqual(raw.signatures, [
      { template: 'a', level: 'ERROR', count: 1 },
      { template: 'b', level: 'WARN', count: 1 },
    ]);
    const loaded = await loadSnapshot('pre', '/my/svc');
    assert.equal(loaded?.name, 'pre');
    assert.equal(await loadSnapshot('pre', '/other'), undefined);
    assert.throws(() => snapPath('../evil', 'x'), /snapshot name/);
  } finally {
    if (prev === undefined) delete process.env.SQUIRT_HOME;
    else process.env.SQUIRT_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
