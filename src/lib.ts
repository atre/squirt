// Library entry point (`import { cluster } from 'squirt'`). Side-effect free —
// unlike index.ts, importing this never touches stdin/argv/process.exitCode.
export { cluster, sigId, SEVERITY, toEpoch } from './cluster.js';
export { mask, compileMask } from './mask.js';
export {
  filterSignatures,
  parseLevel,
  renderBrief,
  renderJson,
  renderText,
  shouldFail,
  sparkBuckets,
  type RenderOptions,
} from './render.js';
export {
  diff,
  renderDiffJson,
  renderDiffText,
  toFindings,
  GROWTH_FACTOR,
  type Baseline,
  type DiffEntry,
  type DiffResult,
  type Finding,
} from './diff.js';
export { guardStats, parseDuration } from './guard.js';
export type { ClusterOptions, ClusterResult, Level, Signature, TaggedLine, TimeRange } from './types.js';
