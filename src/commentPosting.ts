import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import { createThreadViaRest } from "./azure.js";
import type { CliOptions } from "./cli.js";
import {
  buildCommentSignature,
  buildSuggestionSignaturePayload,
  normalizeThreadFilePath,
} from "./commentSignatures.js";
import { ReviewError } from "./errors.js";
import { shouldIgnoreFile } from "./ignore.js";
import { getLogger } from "./logging.js";
import { buildFindingsSummary } from "./reviewProcessing.js";
import { renderSuggestionComment } from "./suggestionRendering.js";
import type { ReviewResult } from "./types.js";

export async function postOverallComment(
  options: CliOptions,
  review: ReviewResult,
  repositoryId?: string,
  existingCommentSignatures?: Set<string>,
  reviewedSourceSha?: string,
): Promise<void> {
  const logger = getLogger();
  if (!options.prId) {
    logger.info("No pull request ID detected; skipping overall review comment.");
    return;
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

  const signature = buildCommentSignature({ content: commentText });
  if (signature && existingCommentSignatures?.has(signature)) {
    logger.info("Skipping overall comment; identical content already posted.");
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
  if (signature) {
    existingCommentSignatures?.add(signature);
  }
}

export async function postSuggestions(
  options: CliOptions,
  review: ReviewResult,
  repositoryId?: string,
  existingCommentSignatures?: Set<string>,
): Promise<void> {
  const logger = getLogger();
  if (!options.prId) {
    logger.info("No pull request ID detected; skipping inline suggestion threads.");
    return;
  }
  if (review.suggestions.length === 0) {
    logger.info("No suggestions to post.");
    return;
  }

  const resolvedRepositoryId = repositoryId ?? options.repositoryId;
  if (!resolvedRepositoryId) {
    logger.warn(
      "Repository ID unavailable; skipping inline suggestion threads. Provide --repository-id or ensure PAT access.",
    );
    return;
  }

  for (const suggestion of review.suggestions) {
    if (shouldIgnoreFile(suggestion.file, options.ignoreFiles)) {
      logger.debug("Skipping suggestion for ignored file %s", suggestion.file);
      continue;
    }
    const rendered = renderSuggestionComment(suggestion);
    if (!rendered) {
      logger.debug(
        "Skipping suggestion with empty replacement for %s:%s-%s",
        suggestion.file,
        suggestion.startLine,
        suggestion.endLine,
      );
      continue;
    }
    const { body: suggestionBlock, sanitizedReplacement } = rendered;

    if (options.dryRun) {
      logger.info(
        `Dry-run: would post suggestion to ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine}\n${suggestionBlock}`,
      );
      continue;
    }

    const signature = buildCommentSignature(
      buildSuggestionSignaturePayload(
        { ...suggestion, replacement: sanitizedReplacement },
        suggestionBlock,
      ),
    );
    if (signature && existingCommentSignatures?.has(signature)) {
      logger.info(
        "Skipping already-posted suggestion for %s:%s-%s",
        suggestion.file,
        suggestion.startLine,
        suggestion.endLine,
      );
      continue;
    }

    const thread: GitInterfaces.GitPullRequestCommentThread = {
      status: GitInterfaces.CommentThreadStatus.Active,
      comments: [
        {
          content: suggestionBlock,
          commentType: GitInterfaces.CommentType.Text,
        },
      ],
      threadContext: {
        filePath: normalizeThreadFilePath(suggestion.file),
        rightFileStart: { line: suggestion.startLine, offset: 1 },
        rightFileEnd: { line: suggestion.endLine, offset: 1 },
      },
    };

    await createThread(options, resolvedRepositoryId, thread);
    if (signature) {
      existingCommentSignatures?.add(signature);
    }
  }
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
