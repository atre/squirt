import test from 'node:test';
import { cluster } from '../../src/cluster.js';

// Letter-based worker tag (not digits) so masking doesn't collapse the 50 templates into one.
const TEMPLATES = Array.from(
  { length: 50 },
  (_, i) => `worker-${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))} processed job <id> from <ip> in <n>ms`,
);

async function* generate(n: number): AsyncIterable<string> {
  for (let i = 0; i < n; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const id = (i * 2654435761) % 1_000_000;
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    yield t.replace('<id>', String(id)).replace('<ip>', ip).replace('<n>', String(i % 5000));
  }
}

test('1M lines: streams in bounded time and memory', async (t) => {
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = await cluster(generate(1_000_000));
  const seconds = (performance.now() - start) / 1000;
  const heapDeltaMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  t.diagnostic(`1M lines in ${seconds.toFixed(2)}s, heap +${heapDeltaMb.toFixed(1)}MB`);

  if (seconds >= 15) throw new Error(`too slow: ${seconds.toFixed(2)}s (budget 15s)`);
  if (heapDeltaMb >= 200) throw new Error(`too much memory: +${heapDeltaMb.toFixed(1)}MB (budget 200MB)`);
  if (result.lines !== 1_000_000) throw new Error(`expected 1_000_000 lines, got ${result.lines}`);
  if (result.signatures.length !== 50) throw new Error(`expected 50 signatures, got ${result.signatures.length}`);
});
