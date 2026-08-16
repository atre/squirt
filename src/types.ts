export type Level = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'OTHER';

export interface Signature {
  template: string;
  level: Level;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
  sample: string;
}

export interface ClusterResult {
  lines: number;
  folded: number;
  signatures: Signature[];
}
