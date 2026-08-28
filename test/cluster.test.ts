import test from 'node:test';
import assert from 'node:assert/strict';
import { cluster } from '../src/cluster.js';
import { mask } from '../src/mask.js';
import { renderBrief, renderJson, renderText } from '../src/render.js';

test('collapses repeated messages that differ only in variables', async () => {
  const result = await cluster([
    '2026-08-16T09:14:02Z ERROR pg pool timeout connecting to 10.0.3.4:5432',
    '2026-08-16T09:31:44Z ERROR pg pool timeout connecting to 10.0.3.7:5432',
    '2026-08-16T10:02:11Z ERROR pg pool timeout connecting to 10.0.3.4:5432',
    '2026-08-16T09:20:00Z WARN retry 3 of 5 for job 42',
  ]);

  assert.equal(result.lines, 4);
  assert.equal(result.signatures.length, 2);

  const [error, warn] = result.signatures;
  assert.equal(error.level, 'ERROR');
  assert.equal(error.count, 3);
  assert.equal(error.template, 'pg pool timeout connecting to <ip>');
  assert.equal(error.firstSeen, '2026-08-16T09:14:02Z');
  assert.equal(error.lastSeen, '2026-08-16T10:02:11Z');

  assert.equal(warn.level, 'WARN');
  assert.equal(warn.count, 1);
});

test('folds stack-trace continuation lines into the signature above', async () => {
  const result = await cluster([
    '2026-08-16T09:00:00Z ERROR unhandled TypeError',
    '    at Object.run (/app/dist/worker.js:10:5)',
    '    at process.processTicksAndRejections (node:internal)',
    '2026-08-16T09:05:00Z ERROR unhandled TypeError',
  ]);

  assert.equal(result.folded, 2);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].count, 2);
});

test('masks uuids, hex ids, urls, emails, ips, and numbers', () => {
  const masked = mask(
    'user a1b2c3d4-e5f6-7890-abcd-ef1234567890 (bob@example.com) hit https://api.example.com/v1 from 192.168.1.10 with token deadbeefdeadbeef in 250ms v1.2.3',
  );
  assert.equal(
    masked,
    'user <uuid> (<email>) hit <url> from <ip> with token <hex> in <n>ms v<n>',
  );
});

test('masks ipv6 but not clock times', () => {
  assert.equal(
    mask('peer 2001:db8::1 and [::1]:8080 and 2001:0db8:0000:0000:0000:ff00:0042:8329 at 09:14:02 std::string'),
    'peer <ip> and [<ip>]:<n> and <ip> at <n>:<n>:<n> std::string',
  );
});

test('parses JSON lines: level/msg/time fields, numeric pino levels, err objects', async () => {
  const result = await cluster([
    '{"level":"error","msg":"db timeout","time":"2026-08-16T09:15:00Z","host":"10.0.0.1"}',
    '{"level":"error","msg":"db timeout","time":"2026-08-16T09:16:00Z","host":"10.0.0.2"}',
    '{"level":50,"time":1755335820000,"msg":"request failed","err":{"message":"ECONNRESET","stack":"..."}}',
    '{"level":30,"time":1755335820,"message":"served 42 requests"}',
    '{"severity":"WARNING","event":"disk 91% full","@timestamp":"2026-08-16T09:18:00Z"}',
  ]);

  const [dbTimeout, reqFailed, warn, info] = result.signatures;
  assert.equal(dbTimeout.level, 'ERROR');
  assert.equal(dbTimeout.count, 2);
  assert.equal(dbTimeout.template, 'db timeout');
  assert.equal(dbTimeout.firstSeen, '2026-08-16T09:15:00Z');
  assert.equal(dbTimeout.lastSeen, '2026-08-16T09:16:00Z');

  assert.equal(reqFailed.level, 'ERROR');
  assert.equal(reqFailed.template, 'request failed: ECONNRESET');
  assert.equal(reqFailed.firstSeen, '2025-08-16T09:17:00.000Z');

  assert.equal(warn.level, 'WARN');
  assert.equal(warn.template, 'disk <n>% full');

  assert.equal(info.level, 'INFO');
  assert.equal(info.template, 'served <n> requests');
  assert.equal(info.firstSeen, '2025-08-16T09:17:00.000Z');
});

test('recognises bracketed and syslog timestamps and strips leading level tokens', async () => {
  const result = await cluster([
    '[2026-08-16 09:17:00] app.ERROR: payment failed order=123',
    'Aug 16 09:18:00 host kernel: eth0 link down',
    '2026-08-16T09:19:00Z [info] server started on port 8080',
    '2026-08-16T09:20:00Z level=warn slow query took 900ms',
    '2026-08-16T09:21:00Z INFO: connection error handled gracefully',
  ]);

  const byTemplate = Object.fromEntries(result.signatures.map((s) => [s.template, s]));

  assert.equal(byTemplate['payment failed order=<n>'].level, 'ERROR');
  assert.equal(byTemplate['payment failed order=<n>'].firstSeen, '2026-08-16 09:17:00');

  assert.equal(byTemplate['host kernel: eth<n> link down'].level, 'OTHER');
  assert.equal(byTemplate['host kernel: eth<n> link down'].firstSeen, 'Aug 16 09:18:00');

  assert.equal(byTemplate['server started on port <n>'].level, 'INFO');
  assert.equal(byTemplate['slow query took <n>ms'].level, 'WARN');
  // Leading level wins over a later "error" word.
  assert.equal(byTemplate['connection error handled gracefully'].level, 'INFO');
});

test('accepts async iterables and skips blank lines', async () => {
  async function* gen() {
    yield 'ERROR a';
    yield '';
    yield '   ';
    yield 'ERROR a';
  }
  const result = await cluster(gen());
  assert.equal(result.lines, 2);
  assert.equal(result.signatures[0].count, 2);
});

// ── Phase 1.5 correctness ─────────────────────────────────────────────

test('<hex> requires a letter: long decimals stay <n>', () => {
  assert.equal(mask('ts 1755335820000 tok deadbeefdeadbeef'), 'ts <n> tok <hex>');
});

test('strips ANSI colour codes before parsing', async () => {
  const result = await cluster(['\x1b[31mERROR\x1b[0m boom']);
  assert.equal(result.signatures[0].level, 'ERROR');
  assert.equal(result.signatures[0].template, 'boom');
});

test('does not fold continuation-looking lines after a JSON record', async () => {
  const result = await cluster(['{"level":"error","msg":"x"}', '    at foo']);
  assert.equal(result.signatures.length, 2);
  assert.equal(result.folded, 0);
});

test('surfaces the first useful folded line as detail', async () => {
  const result = await cluster([
    '2026-08-16T09:00:00Z ERROR request failed',
    '    at Object.run (/app/dist/worker.js:10:5)',
    '    Caused by: ETIMEDOUT',
    '    Caused by: something else',
  ]);
  const sig = result.signatures[0];
  assert.equal(sig.detail, 'Caused by: ETIMEDOUT');
  assert.equal(result.folded, 3);
  const text = renderText(result, 20);
  assert.match(text, /\n  ⤷ Caused by: ETIMEDOUT/);
  assert.equal(JSON.parse(renderJson(result, 20)).signatures[0].detail, 'Caused by: ETIMEDOUT');
});

test('body-scan only assigns ERROR/WARN family levels', async () => {
  const result = await cluster(['user asked for INFO x', 'reconnect after ERROR', 'DEBUG leading token ok']);
  const byTemplate = Object.fromEntries(result.signatures.map((s) => [s.template, s.level]));
  assert.equal(byTemplate['user asked for INFO x'], 'OTHER');
  assert.equal(byTemplate['reconnect after ERROR'], 'ERROR');
  assert.equal(byTemplate['leading token ok'], 'DEBUG');
});

test('masks quoted strings and paths', () => {
  assert.equal(mask('open "/data/x1.json" failed'), 'open <str> failed');
  assert.equal(mask('read /var/log/app.log'), 'read <path>');
  assert.equal(mask("can't open 'x'"), "can't open <str>");
  assert.equal(mask('ratio 1/2 and v1.2.3'), 'ratio <n>/<n> and v<n>');
});

test('renders day markers when the span crosses midnight', () => {
  const base = { id: 'aaaa', level: 'ERROR' as const, count: 2, template: 'x', sample: 'x' };
  const iso = renderText(
    { lines: 2, folded: 0, signatures: [{ ...base, firstSeen: '2026-08-15T23:10:00Z', lastSeen: '2026-08-16T01:02:00Z' }] },
    20,
  );
  assert.match(iso, /08-15 23:10→08-16 01:02/);
  const sameDay = renderText(
    { lines: 2, folded: 0, signatures: [{ ...base, firstSeen: '2026-08-16T09:10:00Z', lastSeen: '2026-08-16T10:02:00Z' }] },
    20,
  );
  assert.match(sameDay, /  09:10→10:02  /);
  const syslog = renderText(
    { lines: 2, folded: 0, signatures: [{ ...base, firstSeen: 'Aug 15 23:10:00', lastSeen: 'Aug 16 01:02:00' }] },
    20,
  );
  assert.match(syslog, /Aug 15 23:10→Aug 16 01:02/);
});

test('header shape: N signatures · M lines (K folded)', async () => {
  const result = await cluster(['ERROR a', '    at foo', 'ERROR b']);
  const text = renderText(result, 20);
  assert.equal(text.split('\n')[0], '2 signatures · 3 lines (1 folded)');
  const noFold = renderText(await cluster(['ERROR a']), 20);
  assert.equal(noFold.split('\n')[0], '1 signatures · 1 lines');
});

test('strips kubectl --prefix pod tags and records the first-seen pod', async () => {
  const result = await cluster([
    '[pod/api-7f9/app] 2026-08-16T09:00:00Z ERROR db timeout host=10.0.0.1',
    '[pod/api-7f9/app]     at foo',
    '[pod/api-c21/app] 2026-08-16T09:01:00Z ERROR db timeout host=10.0.0.2',
  ]);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].count, 2);
  assert.equal(result.folded, 1);
  assert.equal(result.signatures[0].source, 'api-7f9');
  assert.match(renderText(result, 20), /\n  ↳ \[api-7f9\] db timeout host=10\.0\.0\.1/);
});

// ── Phase 5 — parsing / robustness backlog ──────────────────────────────

test('folds pretty-printed multi-line JSON into one signature', async () => {
  const result = await cluster(['{', '  "level": "error",', '  "msg": "boom"', '}']);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].level, 'ERROR');
  assert.equal(result.signatures[0].template, 'boom');
  assert.equal(result.lines, 4);
  assert.equal(result.folded, 0);
});

test('multi-line JSON that never closes its braces overflows instead of buffering forever', async () => {
  const lines = ['{', '  "a": {'];
  for (let i = 0; i < 199; i++) lines.push(`  "k${i}": ${i},`);
  const result = await cluster(lines);
  // overflow flushes the buffer through the normal per-line pipeline (which
  // folds the indented fragments as continuations) rather than buffering forever
  assert.equal(result.lines, lines.length);
  assert.ok(result.folded > 0);
});

test('parses logfmt: lifts level/ts, masks the rest as key=value', async () => {
  const result = await cluster([
    'level=info ts=2026-08-16T09:00:00Z msg="user login" user=alice dur=12ms',
    'level=info ts=2026-08-16T09:00:05Z msg="user login" user=bob dur=40ms',
  ]);
  assert.equal(result.signatures.length, 1);
  const sig = result.signatures[0];
  assert.equal(sig.level, 'INFO');
  assert.equal(sig.template, 'msg=<str> user=<v> dur=<n>ms');
  assert.equal(sig.firstSeen, '2026-08-16T09:00:00Z');
});

test('rare-signature promotion: a lone late ERROR bubbles above high-count noise', async () => {
  const lines: string[] = [];
  for (let m = 0; m < 60; m++) lines.push(`2026-08-16T09:${String(m).padStart(2, '0')}:00Z ERROR db timeout`);
  lines.push('2026-08-16T09:59:30Z ERROR disk full');
  const result = await cluster(lines);
  assert.equal(result.signatures[0].template, 'disk full');
  assert.equal(result.signatures[1].count, 60);
});

test('--fuzzy merges near-duplicate templates (same level, ≤2 tokens differ)', async () => {
  const lines = ['ERROR job alpha failed', 'ERROR job beta failed', 'ERROR job alpha failed'];
  const fuzzy = await cluster(lines, { fuzzy: true });
  assert.equal(fuzzy.signatures.length, 1);
  assert.equal(fuzzy.signatures[0].count, 3);
  assert.equal(fuzzy.signatures[0].template, 'job <*> failed');
  const strict = await cluster(lines);
  assert.equal(strict.signatures.length, 2);
});

test('caps huge single lines before masking', async () => {
  const start = performance.now();
  const result = await cluster([`ERROR ${'A'.repeat(200_000)}`]);
  assert.ok(performance.now() - start < 200);
  assert.ok(result.signatures[0].template.length <= 200);
});

test('rejects binary input (NUL byte in the first line)', async () => {
  await assert.rejects(cluster(['\0\x01\x02 binary']), /looks binary/);
});

const MD_TABLE = [
  '| id | name |',
  '|----|----|',
  '| 1 | apple |',
  '| 2 | banana |',
  '| 3 | cherry |',
  '| 4 | date |',
  '| 5 | elderberry |',
  '| 6 | fig |',
  '| 7 | grape |',
  '| 8 | honeydew |',
];

const PLAIN_LOG = [
  '2026-08-16T09:00:00Z ERROR db timeout host=10.0.0.1',
  '2026-08-16T09:00:10Z ERROR db timeout host=10.0.0.2',
  '2026-08-16T09:00:20Z WARN slow query 900ms',
  '2026-08-16T09:00:30Z INFO served 42 requests',
  '2026-08-16T09:00:40Z DEBUG tick',
];

test('flags markdown-table-shaped input with a low-confidence warning', async () => {
  const table = await cluster(MD_TABLE);
  assert.match(table.warning ?? '', /markdown table/);

  const log = await cluster(PLAIN_LOG);
  assert.equal(log.warning, undefined);
});

test('warning surfaces in renderText/renderJson/renderBrief, omitted when unset', async () => {
  const table = await cluster(MD_TABLE);
  const text = renderText(table, { top: 20 });
  assert.match(text.split('\n')[0], /^⚠ .*markdown table/);

  const json = JSON.parse(renderJson(table, { top: 20 }));
  assert.match(json.warning, /markdown table/);

  const brief = renderBrief(table);
  assert.match(brief.split('\n')[0], /^⚠ .*markdown table/);
  assert.ok(brief.split('\n').length <= 10, `got ${brief.split('\n').length} lines`);

  const log = await cluster(PLAIN_LOG);
  assert.doesNotMatch(renderText(log, { top: 20 }), /⚠/);
  assert.ok(!('warning' in JSON.parse(renderJson(log, { top: 20 }))));
});

test('mask: sha256 prefix, short hex ids, base64 blobs, mid-message timestamps', () => {
  assert.equal(mask(`img sha256:${'a'.repeat(64)}`), 'img <sha>');
  assert.equal(mask('tok cafe12 word facade'), 'tok <hex> word facade');
  assert.equal(mask('blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz'), 'blob <b64>');
  assert.equal(mask('token expired at 2026-08-16T09:14:02Z, retry'), 'token expired at <ts>, retry');
  assert.equal(
    mask('peer 2001:db8::1 and [::1]:8080 and 2001:0db8:0000:0000:0000:ff00:0042:8329 at 09:14:02 std::string'),
    'peer <ip> and [<ip>]:<n> and <ip> at <n>:<n>:<n> std::string',
  );
});

// --- 2026-08-28 feedback-round acceptance tests (plans/2026-08-28-ci-lambda-shapes.md) ---

test('CI test-runner failure lines are classified ERROR, not OTHER', async () => {
  const shapes = [
    'FAIL src/app.test.ts',
    'Tests:       1 failed, 4 passed, 5 total',
    'Test Suites: 1 failed, 2 passed, 3 total',
    'FAILED tests/test_thing.py::test_x - AssertionError',
    'E       assert 1 == 2',
    'not ok 1 - should work',
    '--- FAIL: TestThing (0.00s)',
    '  ● App renders without crashing',
  ];
  for (const line of shapes) {
    // Each shape run as the sole line of its own stream — isolates the new
    // FAILURE_SHAPES detection from the pre-existing CONTINUATION folding
    // (a line starting with whitespace, like the jest "●" bullet, folds into
    // whatever signature precedes it when one exists; that behaviour is
    // unchanged and out of scope here).
    const result = await cluster([line]);
    assert.equal(result.signatures.length, 1, `expected one signature for: ${line}`);
    assert.equal(result.signatures[0].level, 'ERROR', `expected ERROR level for: ${line}`);
  }
});

test('Lambda invoke-error JSON with no "level" field is classified ERROR', async () => {
  const result = await cluster([
    '{"errorType":"Error","errorMessage":"boom","trace":["Error: boom","    at handler (/var/task/index.js:3:9)"]}',
  ]);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].level, 'ERROR');
  assert.equal(result.signatures[0].template, 'Error: boom');
});

test('Lambda invoke-error JSON with only FunctionError is classified ERROR', async () => {
  const result = await cluster(['{"FunctionError":"Unhandled","StatusCode":200}']);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].level, 'ERROR');
  assert.equal(result.signatures[0].template, 'FunctionError Unhandled');
});

test('embedded Lambda error JSON mid-line (aws --output text shape) is classified ERROR', async () => {
  // A long tab-separated prefix pushes any literal "ERROR" text past the
  // existing 120-char body-scan window — this is the exact shape reported in
  // squirt/FEEDBACK.md 2026-08-26 (CodeBuild `--output text` line).
  const longPrefix = `i-0abcdef1234567890\t2026-08-26T10:00:00.000Z\t${'x'.repeat(150)}\t`;
  const line = `${longPrefix}{"errorType":"Runtime.HandlerError","errorMessage":"Cannot find module"}`;
  const result = await cluster([line]);
  assert.equal(result.signatures.length, 1);
  assert.equal(result.signatures[0].level, 'ERROR');
  assert.equal(result.signatures[0].template, 'Runtime.HandlerError: Cannot find module');
});

test('LogResult field is base64-decoded and re-clustered with a [LogResult] prefix', async () => {
  const tail = [
    'START RequestId: 1234 Version: $LATEST',
    'ERROR Invoke Error {"errorType":"Error","errorMessage":"boom","trace":[]}',
    'END RequestId: 1234',
    'REPORT RequestId: 1234 Duration: 42.00 ms Billed Duration: 43 ms Memory Size: 128 MB Max Memory Used: 64 MB',
  ].join('\n');
  const b64 = Buffer.from(tail, 'utf8').toString('base64');
  const record = `{"LogResult":"${b64}","ExecutedVersion":"$LATEST"}`;

  const result = await cluster([record]);

  const decodedError = result.signatures.find((s) => s.level === 'ERROR' && s.template.startsWith('[LogResult] '));
  assert.ok(decodedError, 'expected a [LogResult]-prefixed ERROR signature decoded from LogResult');
  assert.match(decodedError!.template, /Invoke Error/);

  // The original record is still clustered — its base64 blob already gets
  // masked to <b64> by the existing generic base64 mask rule (mask.ts), so
  // this is a regression guard, not proof of new behaviour by itself.
  const original = result.signatures.find((s) => s.template.includes('<b64>'));
  assert.ok(original, 'expected the original LogResult record to mask its base64 value to <b64>');
  assert.equal(original!.template.includes(b64), false);
});
