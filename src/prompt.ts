import { encode as encodeToon } from "@toon-format/toon";
import type { ExistingCommentSummary, PullRequestMetadata } from "./azure.js";

const EXISTING_FEEDBACK_HEADER =
  "Existing PR feedback already posted, you MUST NOT report issues that are already covered by existing feedback, if there are no findings then you SHOULD not post at all:";
const MAX_PR_DESCRIPTION_LENGTH = 2000;

type ExistingFeedbackEntry = {
  location: string;
  startLine: number | null;
  endLine: number | null;
  summary: string;
};

function formatExistingFeedbackEntry(
  summary: ExistingCommentSummary,
): ExistingFeedbackEntry | undefined {
  const location = summary.filePath
    ? `${summary.filePath}${
        summary.startLine
          ? `:${summary.startLine}${
              summary.endLine && summary.endLine !== summary.startLine ? `-${summary.endLine}` : ""
            }`
          : ""
      }`
    : "General";
  const normalized = summary.content.replace(/\s+/g, " ").trim();
  const truncated = normalized.length > 280 ? `${normalized.slice(0, 277)}?` : normalized;
  if (truncated.length === 0) {
    return undefined;
  }

  return {
    location,
    startLine: summary.startLine ?? null,
    endLine: summary.endLine ?? null,
    summary: truncated,
  };
}

export function buildExistingFeedbackContext(
  summaries: ExistingCommentSummary[],
  lastReviewedSha?: string,
): string | undefined {
  const maxEntries = 20;
  const displayable = summaries.filter((summary) => summary.content && summary.content.length > 0);

  if (!lastReviewedSha && displayable.length === 0) {
    return undefined;
  }

  const entries = displayable
    .slice(0, maxEntries)
    .map((summary) => formatExistingFeedbackEntry(summary))
    .filter((entry): entry is ExistingFeedbackEntry => Boolean(entry));
  const feedbackPayload: Record<string, unknown> = {
    totalEntries: displayable.length,
    entries,
  };

  if (lastReviewedSha) {
    feedbackPayload.lastReviewedCommit = lastReviewedSha;
  }

  if (displayable.length > maxEntries) {
    feedbackPayload.omittedEntries = displayable.length - maxEntries;
  }

  return [
    EXISTING_FEEDBACK_HEADER,
    "",
    "Existing feedback context (TOON):",
    encodeToon({ existingFeedback: feedbackPayload }, { delimiter: "\t" }),
  ].join("\n");
}

export function buildPullRequestContext(metadata?: PullRequestMetadata): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const title = metadata.title?.trim();
  const description = metadata.description?.trim();
  const source = metadata.sourceRefName?.trim();
  const target = metadata.targetRefName?.trim();

  const prPayload: Record<string, unknown> = {};

  if (title) {
    prPayload.title = title;
  }

  if (source || target) {
    prPayload.branches = {
      source: source ?? "<unknown>",
      target: target ?? "<unknown>",
    };
  }

  if (description) {
    const normalized = description.replace(/\r\n/g, "\n").trim();
    const truncated =
      normalized.length > MAX_PR_DESCRIPTION_LENGTH
        ? `${normalized.slice(0, MAX_PR_DESCRIPTION_LENGTH)}?`
        : normalized;
    if (truncated.length > 0) {
      prPayload.description = truncated;
    }
  }

  if (Object.keys(prPayload).length === 0) {
    return undefined;
  }

  return [
    "Pull request context (from Azure DevOps, TOON format):",
    encodeToon({ pullRequest: prPayload }, { delimiter: "\t" }),
  ].join("\n");
}

export function assembleReviewPrompt(
  diffPrompt: string,
  existingSummaries: ExistingCommentSummary[],
  previousReviewSha: string | undefined,
  metadata: PullRequestMetadata | undefined,
): string {
  const sections: string[] = [];

  const prContext = buildPullRequestContext(metadata);
  if (prContext) {
    sections.push(prContext);
  }

  const existingFeedbackContext = buildExistingFeedbackContext(
    existingSummaries,
    previousReviewSha,
  );
  if (existingFeedbackContext) {
    sections.push(existingFeedbackContext);
  }

  sections.push(diffPrompt);

  return sections.join("\n\n---\n\n");
}
