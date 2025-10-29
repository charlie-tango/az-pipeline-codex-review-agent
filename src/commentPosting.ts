import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
import type { ReviewResult, ReviewSuggestion } from "./types.js";
import { shouldIgnoreFile } from "./ignore.js";

export async function postOverallComment(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
  repositoryId?: string,
  existingCommentSignatures?: Set<string>,
): Promise<void> {
  const logger = getLogger();
  if (!options.prId) {
    logger.info(
      "No pull request ID detected; skipping overall review comment.",
    );
    return;
  }
  const contentLines: string[] = [
    review.summary || "Automated review completed.",
  ];
  if (review.findings.length > 0) {
    contentLines.push(
      "",
      "### Findings",
      ...buildFindingsSummary(review.findings),
    );
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
    logger.info(
      "No pull request ID detected; skipping inline suggestion threads.",
    );
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
    const sanitizedReplacement = sanitizeSuggestionReplacement(suggestion);
    const renderedReplacement =
      renderReplacementForSuggestion(sanitizedReplacement);
    const suggestionBlock = `${contextLines
      .filter((line) => line && line.trim().length > 0)
      .join("\n\n")}\n\n\`\`\`suggestion\n${renderedReplacement}\n\`\`\``;

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
    throw new ReviewError(
      "Azure DevOps project name is required to post comments.",
    );
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
    getLogger().warn(
      "Falling back to Azure DevOps client after REST failure: %s",
      message,
    );
  }

  if (!gitApi) {
    throw new ReviewError(
      "Azure DevOps client unavailable; cannot post comments.",
    );
  }

  getLogger().info("Posting review thread to PR", options.prId);
  await gitApi.createThread(
    thread,
    repositoryId,
    options.prId,
    options.project,
  );
}

function sanitizeSuggestionReplacement(suggestion: ReviewSuggestion): string {
  let normalized = normalizeLineEndings(suggestion.replacement).replace(
    /\s+$/u,
    "",
  );
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

  const pattern = new RegExp(`${escapeForRegex(trimmedOriginal)}\\s*$`, "u");
  if (pattern.test(normalized)) {
    const candidate = normalized.replace(pattern, "").trimEnd();
    if (candidate.length > 0) {
      normalized = candidate;
    }
  }

  return normalized;
}

function renderReplacementForSuggestion(replacement: string): string {
  const normalized = normalizeLineEndings(replacement);
  return normalized.replace(/\n/g, "\r\n");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readOriginalSegment(
  file: string,
  startLine: number,
  endLine: number,
): string | undefined {
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

