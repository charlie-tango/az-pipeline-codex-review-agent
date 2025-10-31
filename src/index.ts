#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  type ExistingCommentSummary,
  fetchExistingCommentSignatures,
  fetchPullRequestMetadata,
  type PullRequestMetadata,
  resolveRepositoryIdViaRest,
} from "./azure.js";
import { type CliOptions, parseArgs, redactOptions } from "./cli.js";
import { callCodex } from "./codex.js";
import { postOverallComment, postSuggestions } from "./commentPosting.js";
import { ReviewError } from "./errors.js";
import { type LoadedDiff, buildPrompt, loadDiff, parseUnifiedDiff, truncateFiles } from "./git.js";
import { filterFileDiffs } from "./ignore.js";
import { createLogger, getLogger, setLogger } from "./logging.js";
import type { Logger } from "./logging.js";
import { assembleReviewPrompt } from "./prompt.js";
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
  let prMetadata: PullRequestMetadata | undefined;
  if (options.prId) {
    try {
      prMetadata = await fetchPullRequestMetadata(options);
    } catch (error) {
      const message = error instanceof ReviewError ? error.message : (error as Error).message;
      logger.warn("Failed to load pull request metadata: %s", message);
    }
  }

  try {
    const diffInfo = await loadDiff(options, previousReviewSha, prMetadata);
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
    const prompt = assembleReviewPrompt(
      diffPrompt,
      existingCommentSummaries,
      previousReviewSha,
      prMetadata,
    );

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
      postingContext.repositoryId,
      postingContext.existingCommentSignatures,
    );
    await postOverallComment(
      options,
      filteredReview,
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
  repositoryId?: string;
  existingCommentSignatures?: Set<string>;
  summaries: ExistingCommentSummary[];
};

async function preparePostingContext(
  options: CliOptions,
  preFetchedSignatures: Set<string> | undefined,
  existingCommentSummaries: ExistingCommentSummary[],
): Promise<PostingContext> {
  let repositoryId: string | undefined = options.repositoryId;
  let signatures = preFetchedSignatures ? new Set(preFetchedSignatures) : undefined;
  let summaries = existingCommentSummaries;

  if (!options.dryRun && options.prId) {
    repositoryId = repositoryId ?? (await resolveRepositoryIdViaRest(options));
  }

  if (!options.dryRun && options.prId && repositoryId) {
    const existing = await fetchExistingCommentSignatures(options, repositoryId);
    signatures = signatures
      ? new Set([...signatures, ...existing.signatures])
      : existing.signatures;
    if (existing.summaries.length > 0) {
      summaries = existing.summaries;
    }
  }

  return {
    repositoryId,
    existingCommentSignatures: signatures,
    summaries,
  };
}

void main();
