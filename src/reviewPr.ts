#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { Codex } from "@openai/codex-sdk";
import azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

const execFileAsync = promisify(execFile);

interface FileDiff {
  path: string;
  diff: string;
}

interface ReviewSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  comment: string;
  replacement: string;
  originFinding?: {
    severity?: string;
    title?: string;
    details?: string;
  };
}

interface Finding {
  severity?: string;
  file?: string;
  line?: number;
  title?: string;
  details?: string;
  suggestion?: {
    file?: string;
    start_line: number;
    end_line?: number;
    comment: string;
    replacement: string;
  } | null;
  [key: string]: unknown;
}

interface ReviewResult {
  summary: string;
  findings: Finding[];
  suggestions: ReviewSuggestion[];
}

const integerFromString = z.coerce.number().int();

const SuggestionDetailsSchema = z.object({
  file: z.string(),
  start_line: integerFromString,
  end_line: integerFromString.optional(),
  comment: z.string(),
  replacement: z.string(),
});

const SuggestionInstructionSchema = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  comment: z.string(),
  replacement: z.string(),
});

const FindingInstructionSchema = z.object({
  severity: z.string(),
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  details: z.string(),
  suggestion: SuggestionInstructionSchema.nullable(),
});

const CodexInstructionSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingInstructionSchema),
  suggestions: z.array(SuggestionInstructionSchema),
});

const FindingSchema = z
  .object({
    severity: z.string().optional(),
    file: z.string().optional(),
    line: integerFromString.optional(),
    title: z.string().optional(),
    details: z.string().optional(),
    suggestion: z.union([SuggestionDetailsSchema, z.null()]).optional().default(null),
  })
  .passthrough();

const SuggestionSchema = z.object({
  file: z.string(),
  start_line: integerFromString,
  end_line: integerFromString.optional(),
  comment: z.string(),
  replacement: z.string(),
});

const ReviewSchema = z.object({
  summary: z.string().optional().default(""),
  findings: z.array(FindingSchema).optional().default([]),
  suggestions: z.array(SuggestionSchema).optional().default([]),
});

const CODEX_OUTPUT_SCHEMA = normalizeJsonSchema(
  z.toJSONSchema(CodexInstructionSchema, {
    target: "openapi-3.0",
  }) as Record<string, unknown>,
);

function normalizeJsonSchema<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeJsonSchema(item)) as unknown as T;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (key === "additionalProperties" && record[key] === false) {
        if (typeof record.type !== "string") {
          record.type = "object";
        }
        continue;
      }

      record[key] = normalizeJsonSchema(record[key]);
    }

    return record as unknown as T;
  }

  return input;
}

function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (hours > 0 || minutes > 0) {
    const wholeSeconds = Math.floor(seconds);
    parts.push(`${wholeSeconds}s`);
  } else {
    const roundedSeconds = Math.round(seconds * 10) / 10;
    parts.push(`${roundedSeconds.toFixed(1)}s`);
  }

  return parts.join(" ");
}

type CliOptions = z.infer<typeof ArgsSchema>;

class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

let logger: Logger = createLogger(false);

function createLogger(debugEnabled: boolean): Logger {
  return {
    debug: (...args: unknown[]) => {
      if (debugEnabled) {
        console.debug("[DEBUG]", ...args);
      }
    },
    info: (...args: unknown[]) => {
      console.log("[INFO]", ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn("[WARN]", ...args);
    },
    error: (...args: unknown[]) => {
      console.error("[ERROR]", ...args);
    },
  };
}

function maskSecret(secret?: string): string | undefined {
  if (!secret) {
    return undefined;
  }
  if (secret.length <= 4) {
    return "***";
  }
  return `${secret.slice(0, 2)}***${secret.slice(-2)}`;
}

function redactOptions(options: CliOptions): Record<string, unknown> {
  const { azureToken, openaiApiKey, ...rest } = options;
  return {
    ...rest,
    azureToken: maskSecret(azureToken),
    openaiApiKey: maskSecret(openaiApiKey),
  };
}

function resolveOrganizationUrl(org: string): string {
  if (org.startsWith("http")) {
    return org.replace(/\/$/, "");
  }
  return `https://dev.azure.com/${org.replace(/^\//, "")}`;
}

function envInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const ArgsSchema = z.object({
  prId: z.coerce
    .number()
    .int("pr-id must be an integer")
    .positive("pr-id must be positive")
    .optional(),
  organization: z.string().trim().min(1, "organization cannot be empty").optional(),
  project: z.string().trim().min(1, "project cannot be empty").optional(),
  repository: z.string().trim().min(1, "repository cannot be empty").optional(),
  repositoryId: z.string().trim().uuid("repository-id must be a valid UUID").optional(),
  targetBranch: z.string().trim().optional(),
  sourceRef: z.string().trim().optional(),
  diffFile: z.string().trim().optional(),
  maxFiles: z.coerce
    .number()
    .int("max-files must be an integer")
    .positive("max-files must be positive")
    .max(100, "max-files cannot exceed 100")
    .default(20),
  maxDiffChars: z.coerce
    .number()
    .int("max-diff-chars must be an integer")
    .positive("max-diff-chars must be positive")
    .default(16000),
  dryRun: z.coerce.boolean().default(false),
  debug: z.coerce.boolean().default(false),
  outputJson: z.string().trim().optional(),
  codexResponseFile: z.string().trim().optional(),
  reviewTimeBudget: z.coerce
    .number()
    .int("review-time-budget must be an integer")
    .positive("review-time-budget must be positive")
    .max(120, "review-time-budget cannot exceed 120 minutes")
    .optional(),
  azureToken: z.string().trim().min(1, "azure-token cannot be empty").optional(),
  openaiApiKey: z.string().trim().min(1, "openai-api-key cannot be empty").optional(),
});

function parseArgs(): CliOptions {
  const argv = yargs(hideBin(process.argv))
    .option("pr-id", {
      type: "number",
      description: "Azure DevOps pull request ID.",
      default: envInt("SYSTEM_PULLREQUEST_PULLREQUESTID"),
    })
    .option("organization", {
      type: "string",
      description: "Azure DevOps organization URL (https://dev.azure.com/contoso).",
      default: process.env.AZURE_DEVOPS_ORG_URL ?? process.env.SYSTEM_COLLECTIONURI,
    })
    .option("project", {
      type: "string",
      description: "Azure DevOps project name.",
      default: process.env.AZURE_DEVOPS_PROJECT ?? process.env.SYSTEM_TEAMPROJECT,
    })
    .option("repository", {
      type: "string",
      description: "Azure DevOps repository name.",
      default: process.env.BUILD_REPOSITORY_NAME,
    })
    .option("repository-id", {
      type: "string",
      description: "Azure DevOps repository ID.",
      default: process.env.BUILD_REPOSITORY_ID,
    })
    .option("target-branch", {
      type: "string",
      description: "Target branch for diff comparisons.",
      default: process.env.SYSTEM_PULLREQUEST_TARGETBRANCH,
    })
    .option("source-ref", {
      type: "string",
      description: "Source ref for diff comparisons.",
      default:
        process.env.SYSTEM_PULLREQUEST_SOURCEBRANCH ??
        process.env.BUILD_SOURCEBRANCH ??
        process.env.BUILD_SOURCEVERSION,
    })
    .option("diff-file", {
      type: "string",
      description: "Path to a diff file for local testing.",
    })
    .option("max-files", {
      type: "number",
      description: "Maximum number of files to include in the Codex prompt.",
      default: 20,
    })
    .option("max-diff-chars", {
      type: "number",
      description: "Maximum total diff characters to include in the prompt.",
      default: 16000,
    })
    .option("dry-run", {
      type: "boolean",
      description: "Skip posting comments; log output only.",
      default: false,
    })
    .option("debug", {
      type: "boolean",
      description: "Enable verbose logging.",
      default: false,
    })
    .option("output-json", {
      type: "string",
      description: "Write the raw Codex response JSON to this path.",
    })
    .option("codex-response-file", {
      type: "string",
      description:
        "Path to a Codex JSON response to reuse instead of calling the agent (for local testing).",
    })
    .option("review-time-budget", {
      type: "number",
      description:
        "Optional time budget (in minutes) to remind Codex to stay within. Omit for no reminder.",
    })
    .option("azure-token", {
      type: "string",
      description:
        "Azure DevOps Personal Access Token (defaults to AZURE_DEVOPS_PAT or SYSTEM_ACCESSTOKEN).",
      default: process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN,
    })
    .option("openai-api-key", {
      type: "string",
      description: "OpenAI API key to use for Codex (defaults to OPENAI_API_KEY env var).",
      default: process.env.OPENAI_API_KEY,
    })
    .help()
    .parseSync();

  const parsed = ArgsSchema.safeParse(argv);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ReviewError(`Invalid CLI arguments: ${message}`);
  }

  return parsed.data;
}

async function runCommand(
  command: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const [file, ...args] = command;
  logger.debug("Running command:", command.join(" "));
  try {
    const { stdout } = await execFileAsync(file, args, {
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stderr = err.stderr ?? "";
    if (options.allowFailure) {
      logger.warn("Command allowed to fail:", stderr.trim());
      return err.stdout ?? "";
    }
    logger.error("Command failed:", stderr.trim());
    throw new ReviewError(`Command ${command.join(" ")} failed: ${stderr.trim() || err.message}`);
  }
}

async function loadDiff(options: CliOptions): Promise<string> {
  if (options.diffFile) {
    const diffPath = path.resolve(options.diffFile);
    logger.info("Loading diff from", diffPath);
    if (!existsSync(diffPath)) {
      throw new ReviewError(`Diff file not found: ${diffPath}`);
    }
    return readFileSync(diffPath, "utf8");
  }

  let targetBranch = options.targetBranch;
  const errors: string[] = [];

  if (options.prId && !targetBranch) {
    try {
      const resolved = await resolvePullRequestTargetBranch(options);
      if (resolved) {
        targetBranch = resolved;
        logger.info(
          "Resolved target branch %s from Azure DevOps for PR #%s",
          targetBranch,
          options.prId,
        );
      }
    } catch (error) {
      const message = (error as Error).message;
      logger.warn("Failed to resolve target branch from Azure DevOps: %s", message);
      errors.push(message);
    }
  }

  if (!targetBranch) {
    try {
      const inferred = await inferTargetBranch(options);
      if (inferred) {
        targetBranch = inferred;
        logger.info("Inferred target branch from repository default: %s", targetBranch);
      }
    } catch (error) {
      const message = (error as Error).message;
      logger.warn("Failed to infer target branch from repository: %s", message);
      errors.push(message);
    }
  }

  if (targetBranch) {
    try {
      return await gitDiff({ ...options, targetBranch });
    } catch (error) {
      const message = (error as Error).message;
      logger.warn("git diff failed: %s", message);
      errors.push(message);
    }
  }

  if (errors.length > 0) {
    throw new ReviewError(`Failed to load pull-request diff: ${errors.join("; ")}`);
  }

  throw new ReviewError(
    "No diff source available. Provide --diff-file or ensure PR metadata is accessible.",
  );
}

async function inferTargetBranch(options: CliOptions): Promise<string | undefined> {
  const envCandidates = [
    process.env.DEFAULT_BRANCH,
    process.env.GITHUB_BASE_REF,
    process.env.BUILD_REPOSITORY_DEFAULT_BRANCH,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  for (const candidate of envCandidates) {
    const normalized = normalizeBranchRef(candidate);
    if (normalized) {
      return normalized;
    }
  }

  if (options.azureToken) {
    try {
      const defaultFromAzure = await resolveDefaultBranchFromAzure(options);
      if (defaultFromAzure) {
        return defaultFromAzure;
      }
    } catch (error) {
      logger.debug(
        "Failed to resolve repository default branch from Azure DevOps: %s",
        (error as Error).message,
      );
    }
  }

  const symbolicRef = (
    await runCommand(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], { allowFailure: true })
  ).trim();
  if (symbolicRef) {
    const match = symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return `refs/heads/${match[1]}`;
    }
  }

  const remoteInfo = (
    await runCommand(["git", "remote", "show", "origin"], { allowFailure: true })
  ).trim();
  if (remoteInfo) {
    const headMatch = remoteInfo.match(/HEAD branch: (.+)/);
    if (headMatch?.[1]) {
      const branch = headMatch[1].trim();
      const normalized = normalizeBranchRef(branch);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function normalizeBranchRef(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("refs/heads/")) {
    return trimmed;
  }
  if (trimmed.startsWith("refs/remotes/origin/")) {
    const branch = trimmed.slice("refs/remotes/origin/".length);
    return branch ? `refs/heads/${branch}` : undefined;
  }
  if (trimmed.startsWith("refs/")) {
    return trimmed;
  }

  const sanitized = trimmed.replace(/^origin\//, "").replace(/^heads\//, "");
  if (!sanitized) {
    return undefined;
  }
  return `refs/heads/${sanitized}`;
}

async function resolveDefaultBranchFromAzure(options: CliOptions): Promise<string | undefined> {
  const { gitApi, repositoryId } = await ensureGitClient(options);
  const repository = await gitApi.getRepository(repositoryId, options.project);
  const defaultBranch = repository?.defaultBranch;
  return normalizeBranchRef(defaultBranch ?? undefined);
}

async function resolveSourceRef(sourceRef?: string): Promise<string> {
  if (sourceRef && (await refExists(sourceRef))) {
    return sourceRef;
  }

  if (sourceRef?.startsWith("refs/heads/")) {
    const branch = sourceRef.slice("refs/heads/".length);
    if (branch && (await refExists(`origin/${branch}`))) {
      logger.info("Resolved source ref %s to origin/%s", sourceRef, branch);
      return `origin/${branch}`;
    }
  }

  if (!(await refExists("HEAD"))) {
    throw new ReviewError("HEAD ref not available in repository.");
  }
  if (sourceRef) {
    logger.warn("Source ref %s unavailable; falling back to HEAD.", sourceRef);
  }
  return "HEAD";
}

async function refExists(ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function gitDiff(options: CliOptions): Promise<string> {
  const targetBranch = options.targetBranch ?? "";
  const branchName = targetBranch.startsWith("refs/heads/")
    ? targetBranch.slice("refs/heads/".length)
    : targetBranch;
  const fetchRef = `origin/${branchName}`;

  await runCommand(["git", "fetch", "origin", branchName], {
    allowFailure: false,
  });
  const sourceRef = await resolveSourceRef(options.sourceRef);
  logger.info("Computing git diff", `${fetchRef}...${sourceRef}`);
  const diff = await runCommand(["git", "diff", "--unified=3", `${fetchRef}...${sourceRef}`]);
  if (!diff.trim()) {
    logger.warn("git diff returned no changes.");
  }
  return diff;
}

function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentLines: string[] = [];
  let currentPath: string | undefined;

  const flushCurrent = () => {
    if (currentPath && currentLines.length > 0) {
      files.push({ path: currentPath, diff: currentLines.join("\n") });
      currentLines = [];
    }
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();
      const parts = line.split(" ");
      if (parts.length >= 4) {
        const pathToken = parts[2];
        currentPath = pathToken.startsWith("a/") ? pathToken.slice(2) : pathToken;
      } else {
        currentPath = "unknown";
      }
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length).trim();
    }
  }

  flushCurrent();

  if (files.length === 0) {
    throw new ReviewError("No file diffs detected in diff payload.");
  }

  return files;
}

function truncateFiles(files: FileDiff[], maxFiles: number, maxChars: number): FileDiff[] {
  const trimmed = files.slice(0, maxFiles);
  const totalChars = trimmed.reduce((acc, file) => acc + file.diff.length, 0);
  if (totalChars <= maxChars) {
    return trimmed;
  }

  const result: FileDiff[] = [];
  let remaining = maxChars;
  for (const file of trimmed) {
    if (remaining <= 0) {
      break;
    }
    if (file.diff.length <= remaining) {
      result.push(file);
      remaining -= file.diff.length;
    } else {
      const truncated = `${file.diff.slice(0, remaining)}\n[... diff truncated ...]`;
      result.push({ path: file.path, diff: truncated });
      remaining = 0;
    }
  }

  if (result.length === 0) {
    throw new ReviewError("Diff too large to include in prompt. Increase max-diff-chars.");
  }

  return result;
}

function buildPrompt(files: FileDiff[]): string {
  const sections = files.map((file) => `File: ${file.path}\n\`\`\`\n${file.diff}\n\`\`\``);
  return sections.join("\n\n");
}

async function resolvePullRequestTargetBranch(options: CliOptions): Promise<string | undefined> {
  if (!options.prId) {
    return undefined;
  }

  if (options.azureToken) {
    try {
      const azTarget = await resolvePullRequestTargetBranchWithAzCli(options);
      if (azTarget) {
        return azTarget;
      }
    } catch (error) {
      logger.debug(
        "Azure CLI target branch lookup failed: %s",
        (error as Error).message ?? String(error),
      );
    }
  }

  if (!options.azureToken) {
    throw new ReviewError("Azure DevOps PAT is required to resolve pull request target branch.");
  }

  const { gitApi, repositoryId } = await ensureGitClient(options);
  const pr = await gitApi.getPullRequest(repositoryId, options.prId, options.project);

  return pr?.targetRefName ?? undefined;
}

async function resolvePullRequestTargetBranchWithAzCli(
  options: CliOptions,
): Promise<string | undefined> {
  if (!options.project || !options.organization) {
    return undefined;
  }
  if (!options.prId) {
    return undefined;
  }

  const orgUrl = resolveOrganizationUrl(options.organization);
  const env = {
    ...process.env,
    AZURE_DEVOPS_EXT_PAT: options.azureToken ?? process.env.AZURE_DEVOPS_EXT_PAT,
  };

  const azArgs = [
    "az",
    "repos",
    "pr",
    "show",
    "--id",
    String(options.prId),
    "--organization",
    orgUrl,
    "--project",
    options.project,
    "--output",
    "json",
  ];

  const stdout = await runCommand(azArgs, { allowFailure: true, env });
  if (!stdout.trim()) {
    return undefined;
  }

  try {
    const payload = JSON.parse(stdout) as { targetRefName?: string | null };
    return payload.targetRefName ?? undefined;
  } catch (error) {
    logger.debug(
      "Failed to parse Azure CLI pull request payload: %s",
      (error as Error).message ?? String(error),
    );
    return undefined;
  }
}

async function callCodex(
  prompt: string,
  options: { timeBudgetMinutes?: number; apiKey?: string } = {},
): Promise<string> {
  const codexOptions = options.apiKey ? { apiKey: options.apiKey } : undefined;
  const codex = new Codex(codexOptions);
  const threadOptions: Parameters<Codex["startThread"]>[0] = {
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
  };
  const thread = codex.startThread(threadOptions);

  logger.info("Requesting review from Codex agent");
  const instructions = [
    {
      type: "text" as const,
      text: "You are an autonomous code-review assistant focused on actionable feedback.",
    },
  ];

  if (typeof options.timeBudgetMinutes === "number" && options.timeBudgetMinutes > 0) {
    instructions.push({
      type: "text",
      text: `Work efficiently and limit your analysis to what you can cover in at most ${options.timeBudgetMinutes} minutes; prioritize the most important issues first.`,
    });
  }

  instructions.push(
    {
      type: "text",
      text: "Analyze the provided unified diff for a pull request and respond in JSON that conforms to the supplied schema.",
    },
    {
      type: "text",
      text: prompt,
    },
  );

  const turn = await thread.run(instructions, {
    outputSchema: CODEX_OUTPUT_SCHEMA,
  });

  const rawOutput =
    typeof turn.finalResponse === "string"
      ? turn.finalResponse
      : JSON.stringify(turn.finalResponse ?? {});
  if (!rawOutput.trim()) {
    throw new ReviewError("Codex response was empty.");
  }

  logger.debug("Raw model output:", rawOutput);
  return rawOutput;
}

function parseReview(rawJson: string): ReviewResult {
  let jsonPayload: unknown;
  try {
    jsonPayload = JSON.parse(rawJson);
  } catch (error) {
    throw new ReviewError(
      `Model response was not valid JSON: ${(error as Error).message}\nOutput: ${rawJson}`,
    );
  }

  let parsed: z.infer<typeof ReviewSchema>;
  try {
    parsed = ReviewSchema.parse(jsonPayload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReviewError(
        `Model response failed validation: ${formatZodError(error)}\nOutput: ${rawJson}`,
      );
    }
    throw new ReviewError(
      `Unexpected error validating model response: ${(error as Error).message}`,
    );
  }

  const summary = parsed.summary.trim();

  const suggestions: ReviewSuggestion[] = [];
  const seenSuggestions = new Set<string>();

  const pushSuggestion = (
    source: {
      file?: string;
      start_line: number;
      end_line?: number;
      comment: string;
      replacement: string;
    },
    context?: {
      file?: string;
      line?: number;
      severity?: string;
      title?: string;
      details?: string;
    },
  ) => {
    const file = source.file ?? context?.file;
    const startLine = source.start_line ?? context?.line;
    if (!file || startLine === undefined || startLine === null) {
      return;
    }
    const endLine = source.end_line ?? context?.line ?? startLine;
    const key = `${file}:${startLine}:${endLine}:${source.comment}:${source.replacement}`;
    if (seenSuggestions.has(key)) {
      return;
    }
    seenSuggestions.add(key);
    suggestions.push({
      file,
      startLine,
      endLine,
      comment: source.comment.trim(),
      replacement: source.replacement.replace(/\s+$/, ""),
      originFinding: context
        ? {
            severity: context.severity,
            title: context.title,
            details: context.details,
          }
        : undefined,
    });
  };

  for (const suggestion of parsed.suggestions) {
    pushSuggestion(suggestion);
  }

  const findings: Finding[] = parsed.findings.map((finding) => {
    const normalized: Finding = {
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      title: finding.title,
      details: finding.details,
      suggestion: finding.suggestion,
    };

    for (const [key, value] of Object.entries(finding)) {
      if (!(key in normalized)) {
        (normalized as Record<string, unknown>)[key] = value;
      }
    }

    if (finding.suggestion && finding.suggestion !== null) {
      pushSuggestion(finding.suggestion, {
        file: finding.suggestion.file ?? finding.file,
        line: finding.suggestion.start_line ?? finding.line,
        severity: finding.severity,
        title: finding.title,
        details: finding.details,
      });
    }

    return normalized;
  });

  return { summary, findings, suggestions };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function buildFindingsSummary(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const severity = (finding.severity ?? "info").toUpperCase();
    const filePath = finding.file ?? finding.suggestion?.file ?? "unknown";
    const lineNumber = finding.line ?? finding.suggestion?.start_line ?? "?";
    const title = finding.title ?? "";
    const details = finding.details ?? "";
    const headerParts = [
      `- **${severity}** ${filePath}:${lineNumber}`,
      title ? `– ${title}` : "",
    ].filter(Boolean);
    const detailLines = [details]
      .filter((value) => value && value.trim().length > 0)
      .map((value) => `  ${value}`);
    if (finding.suggestion && finding.suggestion !== null) {
      detailLines.push(
        `  Suggested fix for lines ${finding.suggestion.start_line}${
          finding.suggestion.end_line &&
          finding.suggestion.end_line !== finding.suggestion.start_line
            ? `-${finding.suggestion.end_line}`
            : ""
        }.`,
      );
    }
    lines.push([headerParts.join(" "), ...detailLines].join("\n"));
  }
  return lines;
}

function logReview(review: ReviewResult): void {
  logger.info("Review summary:\n", review.summary || "<no summary provided>");
  if (review.findings.length > 0) {
    logger.info("Findings:");
    for (const entry of review.findings) {
      logger.info(
        "-",
        JSON.stringify({
          severity: entry.severity,
          file: entry.file,
          line: entry.line,
          title: entry.title,
          hasSuggestion: entry.suggestion != null,
        }),
      );
    }
  }
  if (review.suggestions.length > 0) {
    logger.info("Suggestions:");
    for (const suggestion of review.suggestions) {
      const contextLabel = suggestion.originFinding?.severity
        ? ` (${suggestion.originFinding.severity})`
        : "";
      logger.info(
        `- ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine}${contextLabel} -> ${suggestion.comment.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }
}

async function postOverallComment(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
  repositoryId?: string,
): Promise<void> {
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
}

async function postSuggestions(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
  repositoryId?: string,
): Promise<void> {
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

    const thread: GitInterfaces.GitPullRequestCommentThread = {
      status: GitInterfaces.CommentThreadStatus.Active,
      comments: [
        {
          content: suggestionBlock,
          commentType: GitInterfaces.CommentType.Text,
        },
      ],
      threadContext: {
        filePath: suggestion.file,
        rightFileStart: { line: suggestion.startLine, offset: 1 },
        rightFileEnd: { line: suggestion.endLine, offset: 1 },
      },
    };

    await createThread(options, resolvedRepositoryId, thread, gitApi);
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
    logger.warn("Falling back to Azure DevOps client after REST failure: %s", message);
  }

  if (!gitApi) {
    throw new ReviewError("Azure DevOps client unavailable; cannot post comments.");
  }

  logger.info("Posting review thread to PR", options.prId);
  await gitApi.createThread(thread, repositoryId, options.prId, options.project);
}

async function createThreadViaRest(
  options: CliOptions,
  repositoryId: string,
  thread: GitInterfaces.GitPullRequestCommentThread,
): Promise<void> {
  if (!options.organization) {
    throw new ReviewError("Azure DevOps organization URL is required. Pass --organization.");
  }
  if (!options.azureToken) {
    throw new ReviewError(
      "Azure DevOps PAT not provided. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }
  const project = options.project;
  if (!project) {
    throw new ReviewError("Azure DevOps project name is required. Pass --project.");
  }

  const orgUrl = resolveOrganizationUrl(options.organization);
  const projectSegment = encodeURIComponent(project);
  const url = `${orgUrl}/${projectSegment}/_apis/git/repositories/${repositoryId}/pullRequests/${options.prId}/threads?api-version=7.0`;

  logger.info("Posting review thread to PR %s via REST API", options.prId);
  const authHeader = Buffer.from(`:${options.azureToken}`).toString("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(thread),
  });

  if (response.ok) {
    return;
  }

  const errorBody = (await response.text()).trim();
  const truncatedError = errorBody.length > 500 ? `${errorBody.slice(0, 500)}…` : errorBody;
  throw new ReviewError(
    `Azure DevOps REST create thread failed (${response.status} ${response.statusText})${
      truncatedError ? `: ${truncatedError}` : ""
    }`,
  );
}

async function ensureGitClient(
  options: CliOptions,
): Promise<{ gitApi: IGitApi; repositoryId: string }> {
  if (!options.organization) {
    throw new ReviewError("Azure DevOps organization URL is required. Pass --organization.");
  }
  if (!options.project) {
    throw new ReviewError("Azure DevOps project name is required. Pass --project.");
  }
  const token = options.azureToken;
  if (!token) {
    throw new ReviewError(
      "Azure DevOps PAT not provided. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }

  const orgUrl = resolveOrganizationUrl(options.organization);

  const authHandler = azdev.getPersonalAccessTokenHandler(token);
  const connection = new azdev.WebApi(orgUrl, authHandler);
  const gitApi = await connection.getGitApi();

  const repositoryId = await resolveRepositoryId(options, gitApi);
  return { gitApi, repositoryId };
}

async function resolveRepositoryId(options: CliOptions, gitApi: IGitApi): Promise<string> {
  if (options.repositoryId) {
    return options.repositoryId;
  }
  if (!options.repository) {
    throw new ReviewError("Repository name or ID is required to post comments.");
  }
  const repo = await gitApi.getRepository(options.repository, options.project);
  if (!repo?.id) {
    throw new ReviewError(`Could not resolve repository ID for ${options.repository}`);
  }
  return repo.id;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger = createLogger(options.debug);

  if (options.debug) {
    logger.debug("CLI options:", JSON.stringify(redactOptions(options), null, 2));
  }

  const startTime = Date.now();

  try {
    const diffText = await loadDiff(options);
    const fileDiffs = parseUnifiedDiff(diffText);
    const truncated = truncateFiles(fileDiffs, options.maxFiles, options.maxDiffChars);
    const prompt = buildPrompt(truncated);
    let rawJson: string;
    if (options.codexResponseFile) {
      const responsePath = path.resolve(options.codexResponseFile);
      logger.info("Using Codex response fixture from", responsePath);
      rawJson = readFileSync(responsePath, "utf8");
    } else {
      const openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new ReviewError(
          "OpenAI API key not provided. Set OPENAI_API_KEY or pass --openai-api-key.",
        );
      }
      rawJson = await callCodex(prompt, {
        timeBudgetMinutes: options.reviewTimeBudget,
        apiKey: openaiApiKey,
      });
    }

    if (options.outputJson) {
      writeFileSync(path.resolve(options.outputJson), rawJson, "utf8");
    }

    const review = parseReview(rawJson);
    logReview(review);
    let gitApi: IGitApi | undefined;
    let repositoryId: string | undefined;
    if (!options.dryRun && options.prId) {
      const client = await ensureGitClient(options);
      gitApi = client.gitApi;
      repositoryId = client.repositoryId;
    }
    await postOverallComment(options, review, gitApi, repositoryId);
    await postSuggestions(options, review, gitApi, repositoryId);
    const elapsedMs = Date.now() - startTime;
    logger.info(`Review completed successfully in ${formatElapsed(elapsedMs)}.`);
  } catch (error) {
    const message = error instanceof ReviewError ? error.message : (error as Error).message;
    logger.error("Review failed:", message);
    process.exitCode = 1;
  }
}

void main();
