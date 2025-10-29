import { z } from "zod";

import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import { ReviewSchema } from "./schemas.js";
import type { Finding, ReviewResult, ReviewSuggestion } from "./types.js";

export function parseReview(rawJson: string): ReviewResult {
  let jsonPayload: unknown;
  try {
    jsonPayload = JSON.parse(rawJson);
  } catch (error) {
    throw new ReviewError(
      `Model response was not valid JSON: ${(error as Error).message}\nOutput: ${rawJson}`,
    );
  }

  let parsed: z.infer<typeof ReviewSchema>;
  try {
    parsed = ReviewSchema.parse(jsonPayload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReviewError(
        `Model response failed validation: ${formatZodError(error)}\nOutput: ${rawJson}`,
      );
    }
    throw new ReviewError(
      `Unexpected error validating model response: ${(error as Error).message}`,
    );
  }

  const summary = parsed.summary.trim();

  const suggestions: ReviewSuggestion[] = [];
  const seenSuggestions = new Set<string>();

  const pushSuggestion = (
    source: {
      file?: string;
      start_line: number;
      end_line?: number;
      comment: string;
      replacement: string;
    },
    context?: {
      file?: string;
      line?: number;
      severity?: string;
      title?: string;
      details?: string;
    },
  ) => {
    const file = source.file ?? context?.file;
    const startLine = source.start_line ?? context?.line;
    if (!file || startLine === undefined || startLine === null) {
      return;
    }
    const endLine = source.end_line ?? context?.line ?? startLine;
    const key = `${file}:${startLine}:${endLine}:${source.comment}:${source.replacement}`;
    if (seenSuggestions.has(key)) {
      return;
    }
    seenSuggestions.add(key);
    suggestions.push({
      file,
      startLine,
      endLine,
      comment: source.comment.trim(),
      replacement: source.replacement.replace(/\s+$/, ""),
      originFinding: context
        ? {
            severity: context.severity,
            title: context.title,
            details: context.details,
          }
        : undefined,
    });
  };

  for (const suggestion of parsed.suggestions) {
    pushSuggestion(suggestion);
  }

  const findings: Finding[] = parsed.findings.map((finding) => {
    const normalized: Finding = {
      file: finding.file,
      line: finding.line,
      title: finding.title,
      details: finding.details,
      suggestion: finding.suggestion,
    };

    for (const [key, value] of Object.entries(finding)) {
      if (!(key in normalized)) {
        (normalized as Record<string, unknown>)[key] = value;
      }
    }

    if (finding.suggestion && finding.suggestion !== null) {
      pushSuggestion(finding.suggestion, {
        file: finding.suggestion.file ?? finding.file,
        line: finding.suggestion.start_line ?? finding.line,
        severity: finding.severity,
        title: finding.title,
        details: finding.details,
      });
    }

    return normalized;
  });

  return { summary, findings, suggestions };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function buildFindingsSummary(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const filePath = finding.file ?? finding.suggestion?.file ?? "unknown";
    const lineNumber = finding.line ?? finding.suggestion?.start_line ?? "?";
    const title = finding.title ?? "";
    const details = finding.details ?? "";
    const headerParts = [`-  ${filePath}:${lineNumber}`, title ? `– ${title}` : ""].filter(Boolean);
    const detailLines = [details]
      .filter((value) => value && value.trim().length > 0)
      .map((value) => `  ${value}`);
    if (finding.suggestion && finding.suggestion !== null) {
      detailLines.push(
        `  Suggested fix for lines ${finding.suggestion.start_line}${
          finding.suggestion.end_line &&
          finding.suggestion.end_line !== finding.suggestion.start_line
            ? `-${finding.suggestion.end_line}`
            : ""
        }.`,
      );
    }
    lines.push([headerParts.join(" "), ...detailLines].join("\n"));
  }
  return lines;
}

export function logReview(review: ReviewResult): void {
  const logger = getLogger();
  logger.info("Review summary:\n", review.summary || "<no summary provided>");
  if (review.findings.length > 0) {
    logger.info("Findings:");
    for (const entry of review.findings) {
      logger.info(
        "-",
        JSON.stringify({
          file: entry.file,
          line: entry.line,
          title: entry.title,
          hasSuggestion: entry.suggestion != null,
        }),
      );
    }
  }
  if (review.suggestions.length > 0) {
    logger.info("Suggestions:");
    for (const suggestion of review.suggestions) {
      logger.info(
        `- ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine} -> ${suggestion.comment.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }
}
