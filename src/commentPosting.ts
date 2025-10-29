import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import type { CliOptions } from "./cli.js";
import {
  buildCommentSignature,
  buildSuggestionSignaturePayload,
  normalizeThreadFilePath,
} from "./commentSignatures.js";
import { createThreadViaRest } from "./azure.js";
import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import { buildFindingsSummary } from "./reviewProcessing.js";
import type { ReviewResult } from "./types.js";

export async function postOverallComment(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
  repositoryId?: string,
  existingCommentSignatures?: Set<string>,
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

  if (options.dryRun) {
    logger.info("Dry-run: overall review comment would be:\n", commentText);
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
        content: commentText,
        commentType: GitInterfaces.CommentType.Text,
      },
    ],
  };

  await createThread(options, resolvedRepositoryId, thread, gitApi);
  if (signature) {
    existingCommentSignatures?.add(signature);
  }
}

export async function postSuggestions(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
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
    const contextLines: string[] = [];
    if (suggestion.originFinding) {
      const severity = suggestion.originFinding.severity;
      const title = suggestion.originFinding.title;
      const details = suggestion.originFinding.details;
      const headerParts = [];
      if (severity) {
        headerParts.push(`**${severity.toUpperCase()}**`);
      }
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
    const suggestionBlock = `${contextLines
      .filter((line) => line && line.trim().length > 0)
      .join("\n\n")}\n\n\`\`\`suggestion\n${suggestion.replacement}\n\`\`\``;

    if (options.dryRun) {
      logger.info(
        `Dry-run: would post suggestion to ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine}\n${suggestionBlock}`,
      );
      continue;
    }

    const signature = buildCommentSignature(
      buildSuggestionSignaturePayload(suggestion, suggestionBlock),
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

    await createThread(options, resolvedRepositoryId, thread, gitApi);
    if (signature) {
      existingCommentSignatures?.add(signature);
    }
  }
}

async function createThread(
  options: CliOptions,
  repositoryId: string,
  thread: GitInterfaces.GitPullRequestCommentThread,
  gitApi?: IGitApi,
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

  try {
    await createThreadViaRest(options, repositoryId, thread);
    return;
  } catch (error) {
    const message = (error as Error).message;
    getLogger().warn("Falling back to Azure DevOps client after REST failure: %s", message);
  }

  if (!gitApi) {
    throw new ReviewError("Azure DevOps client unavailable; cannot post comments.");
  }

  getLogger().info("Posting review thread to PR", options.prId);
  await gitApi.createThread(thread, repositoryId, options.prId, options.project);
}
