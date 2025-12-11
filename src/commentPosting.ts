import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import { type ExistingCommentSummary, createThreadViaRest } from "./azure.js";
import type { CliOptions } from "./cli.js";

import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import { buildFindingsSummary } from "./reviewProcessing.js";
import type { ReviewResult } from "./types.js";

export async function postOverallComment(
  options: CliOptions,
  review: ReviewResult,
  repositoryId?: string,
  reviewedSourceSha?: string,
  existingComments?: ExistingCommentSummary[],
): Promise<void> {
  const logger = getLogger();
  if (!options.prId) {
    logger.info("No pull request ID detected; skipping overall review comment.");
    return;
  }

  // Check if we already posted a comment for this exact SHA
  if (reviewedSourceSha && existingComments) {
    const alreadyReviewed = existingComments.some(
      (comment) => comment.reviewHeadSha === reviewedSourceSha,
    );
    if (alreadyReviewed) {
      logger.info(
        "A review comment for commit %s already exists; skipping duplicate comment.",
        reviewedSourceSha.slice(0, 12),
      );
      return;
    }
  }

  const contentLines: string[] = [review.summary || "Automated review completed."];
  if (review.findings.length > 0) {
    contentLines.push("", "### Findings", ...buildFindingsSummary(review.findings));
  }
  const commentText = contentLines.join("\n").trim();
  const finalCommentText = reviewedSourceSha
    ? `${commentText}\n\n<!-- codex-review-head: ${reviewedSourceSha} -->`
    : commentText;

  if (options.dryRun) {
    logger.info("Dry-run: overall review comment would be:\n", finalCommentText);
    return;
  }
  const resolvedRepositoryId = repositoryId ?? options.repositoryId;
  if (!resolvedRepositoryId) {
    logger.warn(
      "Repository ID unavailable; cannot post overall comment. Provide --repository-id or ensure PAT access.",
    );
    return;
  }

  const thread: GitInterfaces.GitPullRequestCommentThread = {
    status: GitInterfaces.CommentThreadStatus.Active,
    comments: [
      {
        content: finalCommentText,
        commentType: GitInterfaces.CommentType.Text,
      },
    ],
  };

  await createThread(options, resolvedRepositoryId, thread);
}

async function createThread(
  options: CliOptions,
  repositoryId: string,
  thread: GitInterfaces.GitPullRequestCommentThread,
): Promise<void> {
  if (!options.project) {
    throw new ReviewError("Azure DevOps project name is required to post comments.");
  }
  if (!options.prId) {
    throw new ReviewError("Pull request ID is required to post comments.");
  }

  if (!repositoryId) {
    throw new ReviewError("Repository ID is required to post comments.");
  }

  await createThreadViaRest(options, repositoryId, thread);
}
