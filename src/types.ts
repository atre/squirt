export type Level = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'OTHER';

export interface Signature {
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
  /** Provenance of the first-seen line: kubectl --prefix pod name, or file basename with --merge. */
  source?: string;
  /** Fine-grained time histogram (internal; rendered as a sparkline). */
  hist?: number[];
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
}
