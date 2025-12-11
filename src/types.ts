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

export interface ReviewSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  comment: string;
  replacement: string;
  originFinding?: Finding;
}
