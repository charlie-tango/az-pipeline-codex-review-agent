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

/**
 * Sanitizes suggestion replacements according to Azure DevOps spec.
 *
 * Azure DevOps treats the suggestion block as the exact replacement for the target lines.
 * We keep sanitization intentionally minimal so behavior stays predictable:
 *   1. Normalize line endings and trim trailing whitespace
 *   2. Remove the exact original block if the model mistakenly appended it
 */
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

  const pattern = new RegExp(`${escapeForRegex(trimmedOriginal)}\s*$`, "u");
  if (pattern.test(normalized)) {
    const candidate = normalized.replace(pattern, "").trimEnd();
    normalized = candidate;
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
