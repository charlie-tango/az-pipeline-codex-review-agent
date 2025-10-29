#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { type CliOptions, parseArgs, redactOptions } from "./cli.js";
import { callCodex } from "./codex.js";
import {
  ensureGitClient,
  fetchExistingCommentSignatures,
  type IGitApi,
} from "./azure.js";
import {
  loadDiff,
  parseUnifiedDiff,
  truncateFiles,
  buildPrompt,
} from "./git.js";
import { createLogger, setLogger, getLogger } from "./logging.js";
import { postOverallComment, postSuggestions } from "./commentPosting.js";
import { parseReview, logReview } from "./reviewProcessing.js";
import { ReviewError } from "./errors.js";
import { formatElapsed } from "./utils.js";

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs();
  } catch (error) {
    const message =
      error instanceof ReviewError ? error.message : (error as Error).message;
    console.error("[ERROR]", message);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(options.debug);
  setLogger(logger);

  if (options.debug) {
    logger.debug(
      "CLI options:",
      JSON.stringify(redactOptions(options), null, 2),
    );
  }

  const startTime = Date.now();

  try {
    const diffText = await loadDiff(options);
    const fileDiffs = parseUnifiedDiff(diffText);
    const truncated = truncateFiles(
      fileDiffs,
      options.maxFiles,
      options.maxDiffChars,
    );
    const prompt = buildPrompt(truncated);

    const rawJson = await obtainReviewJson(prompt, options);
    const review = parseReview(rawJson);

    if (options.outputJson) {
      writeFileSync(path.resolve(options.outputJson), rawJson, "utf8");
    }

    logReview(review);

    let gitApi: IGitApi | undefined;
    let repositoryId: string | undefined;
    let existingCommentSignatures: Set<string> | undefined;

    if (!options.dryRun && options.prId) {
      const client = await ensureGitClient(options);
      gitApi = client.gitApi;
      repositoryId = client.repositoryId;

      existingCommentSignatures = await fetchExistingCommentSignatures(
        options,
        repositoryId,
        gitApi,
      );
    }

    await postSuggestions(
      options,
      review,
      gitApi,
      repositoryId,
      existingCommentSignatures,
    );
    await postOverallComment(
      options,
      review,
      gitApi,
      repositoryId,
      existingCommentSignatures,
    );

    const elapsedMs = Date.now() - startTime;
    logger.info(
      `Review completed successfully in ${formatElapsed(elapsedMs)}.`,
    );
  } catch (error) {
    const message =
      error instanceof ReviewError ? error.message : (error as Error).message;
    logger.error("Review failed:", message);
    process.exitCode = 1;
  }
}

async function obtainReviewJson(
  prompt: string,
  options: CliOptions,
): Promise<string> {
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
  });
}

void main();
