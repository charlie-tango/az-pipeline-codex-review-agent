import micromatch from "micromatch";

import type { FileDiff } from "./types";

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function shouldIgnoreFile(
  filePath: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normalized = normalizeFilePath(filePath);
  return micromatch.isMatch(normalized, patterns, {
    dot: true,
  });
}

export function filterDiffsByIgnorePatterns<T extends { path: string }>(
  diffs: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) {
    return [...diffs];
  }
  return diffs.filter((diff) => !shouldIgnoreFile(diff.path, patterns));
}

export function filterReviewFiles<T extends { file?: string; suggestion?: { file?: string } | null }>(
  items: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) {
    return [...items];
  }
  return items.filter((item) => {
    const directFile = item.file;
    const suggestionFile = item.suggestion?.file;
    const effectiveFile = directFile ?? suggestionFile;
    if (!effectiveFile) {
      return true;
    }
    return !shouldIgnoreFile(effectiveFile, patterns);
  });
}

export function filterSuggestionsByIgnorePatterns<T extends { file: string }>(
  suggestions: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) {
    return [...suggestions];
  }
  return suggestions.filter((suggestion) => !shouldIgnoreFile(suggestion.file, patterns));
}

export function filterFileDiffs(
  fileDiffs: readonly FileDiff[],
  patterns: readonly string[] | undefined,
): FileDiff[] {
  return filterDiffsByIgnorePatterns(fileDiffs, patterns);
}
