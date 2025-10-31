import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ReviewSuggestion } from "./types.js";

export type RenderedSuggestion = {
  body: string;
  sanitizedReplacement: string;
};

export function renderSuggestionComment(suggestion: ReviewSuggestion): RenderedSuggestion | null {
  const sanitizedReplacement = sanitizeSuggestionReplacement(suggestion);
  if (!sanitizedReplacement) {
    return null;
  }

  const contextLines = buildSuggestionContextLines(suggestion);
  const renderedReplacement = renderReplacementForSuggestion(sanitizedReplacement);
  const body = `${contextLines
    .filter((line) => line && line.trim().length > 0)
    .join("\n\n")}\n\n\`\`\`suggestion\n${renderedReplacement}\n\`\`\``;

  return { body, sanitizedReplacement };
}

export function buildSuggestionContextLines(suggestion: ReviewSuggestion): string[] {
  const contextLines: string[] = [];
  if (suggestion.originFinding) {
    const title = suggestion.originFinding.title;
    const details = suggestion.originFinding.details;
    const headerParts = [];
    if (title) {
      headerParts.push(title);
    }
    if (headerParts.length > 0) {
      contextLines.push(headerParts.join(" "));
    }
    if (details) {
      contextLines.push(details);
    }
  }
  contextLines.push(suggestion.comment);
  return contextLines;
}

export function sanitizeSuggestionReplacement(suggestion: ReviewSuggestion): string {
  let normalized = normalizeLineEndings(suggestion.replacement).replace(/\s+$/u, "");
  if (!normalized) {
    return normalized;
  }

  const originalSegment = readOriginalSegment(
    suggestion.file,
    suggestion.startLine,
    suggestion.endLine,
  );
  if (!originalSegment) {
    return normalized;
  }

  const trimmedOriginal = normalizeLineEndings(originalSegment).trim();
  if (!trimmedOriginal) {
    return normalized;
  }

  const pattern = new RegExp(`${escapeForRegex(trimmedOriginal)}\\s*$`, "u");
  if (pattern.test(normalized)) {
    const candidate = normalized.replace(pattern, "").trimEnd();
    if (candidate.length > 0) {
      normalized = candidate;
    }
  }

  const originalLines = normalizeLineEndings(trimmedOriginal)
    .split("\n")
    .map((line) => line.trimEnd());
  const sanitizedLines = normalizeLineEndings(normalized).split("\n");
  const filteredLines = sanitizedLines
    .map((line) => stripOriginalFragments(line, originalLines))
    .filter((line) => {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) {
        return false;
      }
      if (shouldPreserveOriginalLine(trimmed, originalLines)) {
        return true;
      }
      return !originalLines.some((originalLine) => originalLine.trim() === trimmed.trim());
    });
  const dedupedLines: string[] = [];
  for (const line of filteredLines) {
    if (dedupedLines.length === 0 || dedupedLines[dedupedLines.length - 1] !== line) {
      dedupedLines.push(line);
    }
  }
  if (dedupedLines.length > 0) {
    normalized = dedupedLines.join("\n").replace(/\s+$/u, "");
  }

  return normalized;
}

export function renderReplacementForSuggestion(replacement: string): string {
  const normalized = normalizeLineEndings(replacement);
  return normalized.replace(/\n/g, "\r\n");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readOriginalSegment(file: string, startLine: number, endLine: number): string | undefined {
  const absolute = path.resolve(file);
  if (!existsSync(absolute)) {
    return undefined;
  }
  const content = readFileSync(absolute, "utf8");
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || endLine < startLine || startLine > lines.length) {
    return undefined;
  }
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join("\n");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripOriginalFragments(line: string, originalLines: readonly string[]): string {
  if (!line.trim()) {
    return "";
  }

  const trimmedLine = line.trim();
  for (const original of originalLines) {
    const trimmedOriginal = original.trim();
    if (!trimmedOriginal) {
      continue;
    }
    if (trimmedLine === trimmedOriginal) {
      return isCommentLine(trimmedOriginal) ? line : "";
    }
  }

  const leadingWhitespace = line.match(/^\s*/u)?.[0] ?? "";
  let content = line.slice(leadingWhitespace.length);

  for (const original of originalLines) {
    const trimmed = original.trim();
    if (!trimmed) {
      continue;
    }
    const fragmentPattern = new RegExp(`(^|\\s)${escapeForRegex(trimmed)}(?=\\s|$|,|;|\\))`, "gu");
    content = content.replace(fragmentPattern, (match, prefix) => {
      return prefix ?? "";
    });
  }

  content = content.replace(/\s{2,}/gu, " ").trim();
  if (!content) {
    return "";
  }
  return `${leadingWhitespace}${content}`;
}

function shouldPreserveOriginalLine(
  trimmedLine: string,
  originalLines: readonly string[],
): boolean {
  return originalLines.some((originalLine) => {
    const trimmedOriginal = originalLine.trim();
    return trimmedOriginal === trimmedLine && isCommentLine(trimmedOriginal);
  });
}

function isCommentLine(value: string): boolean {
  const normalized = value.trimStart();
  return (
    normalized.startsWith("//") ||
    normalized.startsWith("/*") ||
    normalized.startsWith("* ") ||
    normalized === "*" ||
    normalized.startsWith("*/")
  );
}
