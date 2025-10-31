import type { ExistingCommentSummary, PullRequestMetadata } from "./azure.js";

const EXISTING_FEEDBACK_HEADER =
  "Existing PR feedback already posted, you MUST NOT report issues that are already covered by existing feedback, if there are no findings then you SHOULD not post at all:";
const MAX_PR_DESCRIPTION_LENGTH = 2000;

export function buildExistingFeedbackContext(
  summaries: ExistingCommentSummary[],
  lastReviewedSha?: string,
): string | undefined {
  const maxEntries = 20;
  const displayable = summaries.filter((summary) => summary.content && summary.content.length > 0);

  if (!lastReviewedSha && displayable.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  if (lastReviewedSha) {
    lines.push(`Last reviewed commit: ${lastReviewedSha.slice(0, 12)}`);
  }

  for (const summary of displayable.slice(0, maxEntries)) {
    const location = summary.filePath
      ? `${summary.filePath}${
          summary.startLine
            ? `:${summary.startLine}${
                summary.endLine && summary.endLine !== summary.startLine
                  ? `-${summary.endLine}`
                  : ""
              }`
            : ""
        }`
      : "General";
    const normalized = summary.content.replace(/\s+/g, " ").trim();
    const truncated = normalized.length > 280 ? `${normalized.slice(0, 277)}?` : normalized;
    if (truncated.length > 0) {
      lines.push(`- ${location}: ${truncated}`);
    }
  }

  if (displayable.length > maxEntries) {
    lines.push(`- ?plus ${displayable.length - maxEntries} more existing comment(s).`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  return [EXISTING_FEEDBACK_HEADER, ...lines].join("\n");
}

export function buildPullRequestContext(metadata?: PullRequestMetadata): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const title = metadata.title?.trim();
  const description = metadata.description?.trim();
  const source = metadata.sourceRefName?.trim();
  const target = metadata.targetRefName?.trim();

  const sections: string[] = [];
  if (title) {
    sections.push(`Title: ${title}`);
  }

  if (source || target) {
    const sourceLabel = source ?? "<unknown>";
    const targetLabel = target ?? "<unknown>";
    sections.push(`Branches: ${sourceLabel} -> ${targetLabel}`);
  }

  if (description) {
    const normalized = description.replace(/\r\n/g, "\n").trim();
    const truncated =
      normalized.length > MAX_PR_DESCRIPTION_LENGTH
        ? `${normalized.slice(0, MAX_PR_DESCRIPTION_LENGTH)}?`
        : normalized;
    if (truncated.length > 0) {
      sections.push(`Description:\n${truncated}`);
    }
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["Pull request context (from Azure DevOps):", ...sections].join("\n\n");
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
