#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  type ExistingCommentSummary,
  type IGitApi,
  ensureGitClient,
  fetchExistingCommentSignatures,
} from "./azure.js";
import { type CliOptions, parseArgs, redactOptions } from "./cli.js";
import { callCodex } from "./codex.js";
import { postOverallComment, postSuggestions } from "./commentPosting.js";
import { ReviewError } from "./errors.js";
import { type LoadedDiff, buildPrompt, loadDiff, parseUnifiedDiff, truncateFiles } from "./git.js";
import { filterFileDiffs } from "./ignore.js";
import { createLogger, getLogger, setLogger } from "./logging.js";
import type { Logger } from "./logging.js";
import { filterReviewByIgnorePatterns, logReview, parseReview } from "./reviewProcessing.js";
import { formatElapsed } from "./utils.js";

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs();
  } catch (error) {
    const message = error instanceof ReviewError ? error.message : (error as Error).message;
    console.error("[ERROR]", message);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(options.debug);
  setLogger(logger);

  if (options.debug) {
    logger.debug("CLI options:", JSON.stringify(redactOptions(options), null, 2));
  }

  const startTime = Date.now();
  const prefetchResult = await prefetchExistingFeedback(options, logger);
  let existingCommentSummaries = prefetchResult.summaries;
  const preFetchedSignatures = prefetchResult.preFetchedSignatures;

  const previousReviewSha = findLatestReviewedSha(existingCommentSummaries);

  try {
    const diffInfo = await loadDiff(options, previousReviewSha);
    if (!diffInfo.diffText.trim()) {
      if (diffInfo.baseSha) {
        logger.info(
          "No changes detected since last reviewed commit %s; skipping review.",
          diffInfo.baseSha.slice(0, 12),
        );
        return;
      }
      logger.warn("Diff contained no changes; skipping review.");
      return;
    }

    const fileDiffs = parseUnifiedDiff(diffInfo.diffText);
    const filteredDiffs = filterFileDiffs(fileDiffs, options.ignoreFiles);

    if (filteredDiffs.length === 0) {
      logger.info("All changed files are ignored by configured patterns; skipping Codex review.");
      return;
    }

    const truncated = truncateFiles(filteredDiffs, options.maxFiles, options.maxDiffChars);
    const diffPrompt = buildPrompt(truncated);
    const prompt = assembleReviewPrompt(diffPrompt, existingCommentSummaries, previousReviewSha);

    const rawJson = await obtainReviewJson(prompt, options);
    const review = parseReview(rawJson);
    const filteredReview = filterReviewByIgnorePatterns(review, options.ignoreFiles);

    if (options.outputJson) {
      writeFileSync(path.resolve(options.outputJson), rawJson, "utf8");
    }

    logReview(filteredReview);

    const postingContext = await preparePostingContext(
      options,
      preFetchedSignatures,
      existingCommentSummaries,
    );
    existingCommentSummaries = postingContext.summaries;

    await postSuggestions(
      options,
      filteredReview,
      postingContext.gitApi,
      postingContext.repositoryId,
      postingContext.existingCommentSignatures,
    );
    await postOverallComment(
      options,
      filteredReview,
      postingContext.gitApi,
      postingContext.repositoryId,
      postingContext.existingCommentSignatures,
      diffInfo.sourceSha,
    );

    const elapsedMs = Date.now() - startTime;
    logger.info(`Review completed successfully in ${formatElapsed(elapsedMs)}.`);
  } catch (error) {
    const message = error instanceof ReviewError ? error.message : (error as Error).message;
    logger.error("Review failed:", message);
    process.exitCode = 1;
  }
}

async function obtainReviewJson(prompt: string, options: CliOptions): Promise<string> {
  const logger = getLogger();

  if (options.codexResponseFile) {
    const responsePath = path.resolve(options.codexResponseFile);
    logger.info("Using Codex response fixture from", responsePath);
    return readFileSync(responsePath, "utf8");
  }

  const openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new ReviewError(
      "OpenAI API key not provided. Set OPENAI_API_KEY or pass --openai-api-key.",
    );
  }

  return callCodex(prompt, {
    timeBudgetMinutes: options.reviewTimeBudget,
    apiKey: openaiApiKey,
    instructionOverride: options.prompt,
  });
}

function findLatestReviewedSha(summaries: ExistingCommentSummary[]): string | undefined {
  const candidates = summaries
    .filter((summary) => summary.reviewHeadSha)
    .sort((a, b) => (b.commentId ?? 0) - (a.commentId ?? 0));
  return candidates[0]?.reviewHeadSha;
}

function buildExistingFeedbackContext(
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
    const truncated = normalized.length > 280 ? `${normalized.slice(0, 277)}…` : normalized;
    if (truncated.length > 0) {
      lines.push(`- ${location}: ${truncated}`);
    }
  }

  if (displayable.length > maxEntries) {
    lines.push(`- …plus ${displayable.length - maxEntries} more existing comment(s).`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  return [
    "Existing PR feedback already posted, you MUST NOT report issues that are already covered by existing feedback, if there are no findings then you SHOULD not post at all:",
    ...lines,
  ].join("\n");
}

type PrefetchResult = {
  summaries: ExistingCommentSummary[];
  preFetchedSignatures?: Set<string>;
};

async function prefetchExistingFeedback(
  options: CliOptions,
  logger: Logger,
): Promise<PrefetchResult> {
  if (options.prId && options.repositoryId && options.azureToken) {
    try {
      const existing = await fetchExistingCommentSignatures(options, options.repositoryId);
      return {
        summaries: existing.summaries,
        preFetchedSignatures: existing.signatures,
      };
    } catch (error) {
      const message = error instanceof ReviewError ? error.message : (error as Error).message;
      logger.warn("Failed to load existing PR feedback for prompt context: %s", message);
    }
  }

  return { summaries: [], preFetchedSignatures: undefined };
}

type PostingContext = {
  gitApi?: IGitApi;
  repositoryId?: string;
  existingCommentSignatures?: Set<string>;
  summaries: ExistingCommentSummary[];
};

async function preparePostingContext(
  options: CliOptions,
  preFetchedSignatures: Set<string> | undefined,
  existingCommentSummaries: ExistingCommentSummary[],
): Promise<PostingContext> {
  let gitApi: IGitApi | undefined;
  let repositoryId: string | undefined;
  let signatures = preFetchedSignatures ? new Set(preFetchedSignatures) : undefined;
  let summaries = existingCommentSummaries;

  if (!options.dryRun && options.prId) {
    const client = await ensureGitClient(options);
    gitApi = client.gitApi;
    repositoryId = client.repositoryId;

    const existing = await fetchExistingCommentSignatures(options, repositoryId, gitApi);
    signatures = signatures
      ? new Set([...signatures, ...existing.signatures])
      : existing.signatures;
    if (existing.summaries.length > 0) {
      summaries = existing.summaries;
    }
  }

  return {
    gitApi,
    repositoryId,
    existingCommentSignatures: signatures,
    summaries,
  };
}

function assembleReviewPrompt(
  diffPrompt: string,
  existingSummaries: ExistingCommentSummary[],
  previousReviewSha: string | undefined,
): string {
  const existingFeedbackContext = buildExistingFeedbackContext(
    existingSummaries,
    previousReviewSha,
  );
  return existingFeedbackContext
    ? `${existingFeedbackContext}\n\n---\n\n${diffPrompt}`
    : diffPrompt;
}

void main();
