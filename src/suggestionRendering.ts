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
 * Sanitization:
 *   1. Normalize line endings and trim trailing whitespace
 *   2. Remove trailing lines that match the original (model often appends original by mistake)
 */
export function sanitizeSuggestionReplacement(suggestion: ReviewSuggestion): string {
  let normalized = normalizeLineEndings(suggestion.replacement).replace(/\s+$/u, "");

  if (!normalized) {
    return normalized;
  }

  // Try to read the original lines to detect if model appended them
  const originalSegment = readOriginalSegment(
    suggestion.file,
    suggestion.startLine,
    suggestion.endLine,
  );

  if (originalSegment) {
    const originalLines = normalizeLineEndings(originalSegment)
      .split("\n")
      .map((line) => line.trim());
    const replacementLines = normalized.split("\n");

    console.error(
      `[DEBUG] Suggestion for ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine}`,
    );
    console.error(`[DEBUG] Original lines (${originalLines.length}):`, originalLines);
    console.error(
      `[DEBUG] Replacement lines (${replacementLines.length}):`,
      replacementLines.map((l) => l.trim()),
    );

    // Remove trailing lines from replacement that match any original line
    let trimCount = 0;
    for (let i = replacementLines.length - 1; i >= 0; i--) {
      const replacementLine = replacementLines[i].trim();
      if (originalLines.some((origLine) => origLine === replacementLine)) {
        trimCount++;
      } else {
        break;
      }
    }

    console.error(`[DEBUG] Trim count: ${trimCount}`);

    if (trimCount > 0 && trimCount < replacementLines.length) {
      normalized = replacementLines.slice(0, replacementLines.length - trimCount).join("\n");
    }
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
