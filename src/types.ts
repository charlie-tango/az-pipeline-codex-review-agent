export interface FileDiff {
  path: string;
  diff: string;
}

export interface Finding {
  file?: string;
  line?: number;
  title?: string;
  details?: string;
  // Allow additional model-supplied metadata.
  [key: string]: unknown;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}
