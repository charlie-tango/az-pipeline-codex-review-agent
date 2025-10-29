import type { ReviewSuggestion } from "./types.js";

export function normalizeThreadFilePath(file: string): string {
  const normalized = file.replace(/\\/g, "/").replace(/^\/+/, "");
  return `/${normalized}`;
}

export function buildCommentSignature({
  content,
  filePath,
  startLine,
  endLine,
}: {
  content?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}): string | undefined {
  if (!content) {
    return undefined;
  }
  const normalizedContent = content.trim().replace(/\s+$/u, "");
  if (normalizedContent.length === 0) {
    return undefined;
  }
  const normalizedPath = filePath ? normalizeThreadFilePath(filePath) : "";
  const start =
    typeof startLine === "number" && Number.isFinite(startLine) ? startLine : 0;
  const end =
    typeof endLine === "number" && Number.isFinite(endLine)
      ? endLine
      : typeof startLine === "number" && Number.isFinite(startLine)
        ? startLine
        : 0;
  return `${normalizedPath}::${start}::${end}::${normalizedContent}`;
}

export function buildSuggestionSignaturePayload(
  suggestion: ReviewSuggestion,
  renderedComment: string,
): {
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
} {
  return {
    content: renderedComment,
    filePath: suggestion.file,
    startLine: suggestion.startLine,
    endLine: suggestion.endLine,
  };
}
