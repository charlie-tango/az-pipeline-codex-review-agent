export interface FileDiff {
  path: string;
  diff: string;
}

export interface ReviewSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  comment: string;
  replacement: string;
  originFinding?: {
    severity?: string;
    title?: string;
    details?: string;
  };
}

export interface Finding {
  severity?: string;
  file?: string;
  line?: number;
  title?: string;
  details?: string;
  suggestion?:
    | {
        file?: string;
        start_line: number;
        end_line?: number;
        comment: string;
        replacement: string;
      }
    | null;
  // Allow additional model-supplied metadata.
  [key: string]: unknown;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  suggestions: ReviewSuggestion[];
}