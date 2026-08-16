import type { ClusterResult } from './types.js';

function hhmm(ts?: string): string {
  const m = ts?.match(/\d{2}:\d{2}/);
  return m ? m[0] : '';
}

export function renderText(result: ClusterResult, top: number): string {
  const out: string[] = [];
  const foldNote = result.folded ? ` · ${result.folded} continuation lines folded` : '';
  out.push(`${result.signatures.length} signatures · ${result.lines} lines${foldNote}`);

  for (const sig of result.signatures.slice(0, top)) {
    const first = hhmm(sig.firstSeen);
    const lastT = hhmm(sig.lastSeen);
    const span = first && lastT && first !== lastT ? `${first}→${lastT}` : first;
    out.push(`[${sig.level}] ×${sig.count}${span ? `  ${span}` : ''}  ${sig.template}`);
    if (sig.sample !== sig.template) out.push(`  ↳ ${sig.sample}`);
  }

  const hidden = result.signatures.length - top;
  if (hidden > 0) out.push(`… ${hidden} more signatures (raise --top)`);
  return out.join('\n');
}

export function renderJson(result: ClusterResult, top: number): string {
  return JSON.stringify(
    {
      lines: result.lines,
      folded: result.folded,
      totalSignatures: result.signatures.length,
      signatures: result.signatures.slice(0, top),
    },
    null,
    2,
  );
}
