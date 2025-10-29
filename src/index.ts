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
import { buildPrompt, loadDiff, parseUnifiedDiff, truncateFiles } from "./git.js";
import { filterFileDiffs } from "./ignore.js";
import { createLogger, getLogger, setLogger } from "./logging.js";
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
  let existingCommentSummaries: ExistingCommentSummary[] = [];
  let preFetchedSignatures: Set<string> | undefined;

  if (options.prId && options.repositoryId && options.azureToken) {
    try {
      const existing = await fetchExistingCommentSignatures(options, options.repositoryId);
      existingCommentSummaries = existing.summaries;
      preFetchedSignatures = existing.signatures;
    } catch (error) {
      const message = error instanceof ReviewError ? error.message : (error as Error).message;
      logger.warn("Failed to load existing PR feedback for prompt context: %s", message);
    }
  }

  try {
    const diffText = await loadDiff(options);
    const fileDiffs = parseUnifiedDiff(diffText);
    const filteredDiffs = filterFileDiffs(fileDiffs, options.ignoreFiles);

    if (filteredDiffs.length === 0) {
      logger.info("All changed files are ignored by configured patterns; skipping Codex review.");
      return;
    }

    const truncated = truncateFiles(filteredDiffs, options.maxFiles, options.maxDiffChars);
    const diffPrompt = buildPrompt(truncated);
    const existingFeedbackContext = buildExistingFeedbackContext(existingCommentSummaries);
    const prompt = existingFeedbackContext
      ? `${existingFeedbackContext}\n\n---\n\n${diffPrompt}`
      : diffPrompt;

    const rawJson = await obtainReviewJson(prompt, options);
    const review = parseReview(rawJson);
    const filteredReview = filterReviewByIgnorePatterns(review, options.ignoreFiles);

    if (options.outputJson) {
      writeFileSync(path.resolve(options.outputJson), rawJson, "utf8");
    }

    logReview(filteredReview);

    let gitApi: IGitApi | undefined;
    let repositoryId: string | undefined;
    let existingCommentSignatures: Set<string> | undefined = preFetchedSignatures
      ? new Set(preFetchedSignatures)
      : undefined;

    if (!options.dryRun && options.prId) {
      const client = await ensureGitClient(options);
      gitApi = client.gitApi;
      repositoryId = client.repositoryId;

      const existing = await fetchExistingCommentSignatures(options, repositoryId, gitApi);
      existingCommentSignatures = existingCommentSignatures
        ? new Set([...existingCommentSignatures, ...existing.signatures])
        : existing.signatures;
      if (existingCommentSummaries.length === 0) {
        existingCommentSummaries = existing.summaries;
      }
    }

    await postSuggestions(options, filteredReview, gitApi, repositoryId, existingCommentSignatures);
    await postOverallComment(
      options,
      filteredReview,
      gitApi,
      repositoryId,
      existingCommentSignatures,
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

function buildExistingFeedbackContext(summaries: ExistingCommentSummary[]): string | undefined {
  if (!summaries || summaries.length === 0) {
    return undefined;
  }

  const maxEntries = 20;
  const lines: string[] = [];
  for (const summary of summaries.slice(0, maxEntries)) {
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
    lines.push(`- ${location}: ${truncated}`);
  }

  if (summaries.length > maxEntries) {
    lines.push(`- …plus ${summaries.length - maxEntries} more existing comment(s).`);
  }

  return [
    "Existing PR feedback already posted (only report if something materially changed):",
    ...lines,
  ].join("\n");
}

void main();
