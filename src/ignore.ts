import micromatch from "micromatch";

import type { FileDiff } from "./types.js";

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

export function filterReviewFiles<T extends { file?: string }>(
  items: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) {
    return [...items];
  }
  return items.filter((item) => {
    if (!item.file) {
      return true;
    }
    return !shouldIgnoreFile(item.file, patterns);
  });
}

export function filterFileDiffs(
  fileDiffs: readonly FileDiff[],
  patterns: readonly string[] | undefined,
): FileDiff[] {
  return filterDiffsByIgnorePatterns(fileDiffs, patterns);
}
