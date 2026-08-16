import test from 'node:test';
import assert from 'node:assert/strict';
import { cluster } from '../src/cluster.js';
import { mask } from '../src/mask.js';

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
