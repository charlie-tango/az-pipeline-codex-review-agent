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
 * Sanitization is intentionally minimal - only normalize line endings and trim trailing whitespace.
 */
export function sanitizeSuggestionReplacement(suggestion: ReviewSuggestion): string {
  const normalized = normalizeLineEndings(suggestion.replacement).replace(/\s+$/u, "");
  return normalized;
}

export function renderReplacementForSuggestion(replacement: string): string {
  const normalized = normalizeLineEndings(replacement);
  return normalized.replace(/\n/g, "\r\n");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
