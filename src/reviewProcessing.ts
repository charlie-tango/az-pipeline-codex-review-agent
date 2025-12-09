import { z } from "zod";

import { ReviewError } from "./errors.js";
import { shouldIgnoreFile } from "./ignore.js";
import { getLogger } from "./logging.js";
import { ReviewSchema } from "./schemas.js";
import type { Finding, ReviewResult } from "./types.js";

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

  const findings: Finding[] = parsed.findings.map((finding) => {
    const normalized: Finding = {
      file: finding.file,
      line: finding.line,
      title: finding.title,
      details: finding.details,
    };

    for (const [key, value] of Object.entries(finding)) {
      if (!(key in normalized)) {
        (normalized as Record<string, unknown>)[key] = value;
      }
    }

    return normalized;
  });

  return { summary, findings };
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
    const filePath = finding.file ?? "unknown";
    const lineNumber = finding.line ?? "?";
    const title = finding.title ?? "";
    const details = finding.details ?? "";
    const headerParts = [`-  ${filePath}:${lineNumber}`, title ? `– ${title}` : ""].filter(Boolean);
    const detailLines = [details]
      .filter((value) => value && value.trim().length > 0)
      .map((value) => `  ${value}`);
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
        }),
      );
    }
  }
}

export function filterReviewByIgnorePatterns(
  review: ReviewResult,
  patterns: readonly string[] | undefined,
): ReviewResult {
  if (!patterns || patterns.length === 0) {
    return review;
  }

  const filteredFindings = review.findings.filter((finding) => {
    if (!finding.file) {
      return true;
    }
    return !shouldIgnoreFile(finding.file, patterns);
  });

  return {
    summary: review.summary,
    findings: filteredFindings,
  };
}
