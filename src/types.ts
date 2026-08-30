export type Level = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'OTHER';

export interface Signature {
  /** Stable id: 4 hex chars, sha1(`${level} ${template}`). */
  id: string;
  template: string;
  level: Level;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  sample: string;
  /** Extra distinct samples (ERROR only, `--sample <n>`); excludes `sample`. */
  samples?: string[];
  /** First informative folded continuation line (Caused by:, FooError: …). */
  detail?: string;
  /** Folded cause lines (Caused by:, [cause]:, FooError:), capped by --causes. */
  causes?: string[];
  /** Provenance of the first-seen line: kubectl --prefix pod name, or file basename with --merge. */
  source?: string;
  /** Fine-grained time histogram (internal; rendered as a sparkline). */
  hist?: number[];
  /** Single ERROR occurrence in the last 5% of the stream (internal; sort-order only). */
  novel?: boolean;
}

export interface TimeRange {
  /** Epoch ms of the earliest timestamp seen. */
  start: number;
  /** Epoch ms of the latest timestamp seen. */
  end: number;
  /** Width of one `hist` bucket in ms. */
  bucketMs: number;
}

export interface ClusterResult {
  lines: number;
  folded: number;
  signatures: Signature[];
  time?: TimeRange;
  /** Raw timestamp of the earliest / latest timestamped line seen (epoch-ordered, printed as the source wrote it) — the window a digest actually covers. */
  first?: string;
  last?: string;
  /** Raw lines behind `ClusterOptions.show`'s signature id, up to `showLimit`. */
  shown?: string[];
  /** Set when the input looks like structured tabular data (e.g. a markdown table) rather than log lines — dedup may have collapsed real per-row differences. */
  warning?: string;
}

/** A line with optional provenance (file basename, container…). */
export interface TaggedLine {
  text: string;
  source?: string;
}

export interface ClusterOptions {
  /** Extra masking rules applied before the built-ins; matches become `<mask>`. */
  masks?: RegExp[];
  /** Keep up to this many distinct samples for ERROR signatures (default 1). */
  samples?: number;
  /** Longer sample cap (2000 chars instead of 300) — humans reading `--wide`. */
  wide?: boolean;
  /** Merge near-duplicate templates (same level, ≤2 tokens differ) — opt-in. */
  fuzzy?: boolean;
  /** Dump raw lines behind this signature id instead of clustering. */
  show?: string;
  /** Max raw lines to collect for `show` (default 20). */
  showLimit?: number;
  /** Max cause lines kept per signature (default 1, clamped 1..20). */
  causes?: number;
}
