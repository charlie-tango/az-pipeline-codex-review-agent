import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces";
import { OpenAI } from "openai";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = "gpt-5.0-codex";

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
}

interface ReviewResult {
  summary: string;
  findings: Array<Record<string, unknown>>;
  suggestions: ReviewSuggestion[];
}

const integerFromString = z.coerce.number().int();

const FindingSchema = z
  .object({
    severity: z.string().optional(),
    file: z.string().optional(),
    line: integerFromString.optional(),
    title: z.string().optional(),
    details: z.string().optional(),
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

interface CliOptions {
  prId?: number;
  organization?: string;
  project?: string;
  repository?: string;
  repositoryId?: string;
  targetBranch?: string;
  sourceRef?: string;
  diffFile?: string;
  maxFiles: number;
  maxDiffChars: number;
  openaiApiKey?: string;
  openaiModel: string;
  maxOutputTokens: number;
  dryRun: boolean;
  debug: boolean;
  outputJson?: string;
  azureToken?: string;
}

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

function envInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseArgs(): CliOptions {
  const argv = yargs(hideBin(process.argv))
    .option("pr-id", {
      type: "number",
      description: "Azure DevOps pull request ID.",
      default: envInt("SYSTEM_PULLREQUEST_PULLREQUESTID"),
    })
    .option("organization", {
      type: "string",
      description:
        "Azure DevOps organization URL (https://dev.azure.com/contoso).",
      default:
        process.env.AZURE_DEVOPS_ORG_URL ?? process.env.SYSTEM_COLLECTIONURI,
    })
    .option("project", {
      type: "string",
      description: "Azure DevOps project name.",
      default:
        process.env.AZURE_DEVOPS_PROJECT ?? process.env.SYSTEM_TEAMPROJECT,
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
      default: process.env.BUILD_SOURCEBRANCH,
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
    .option("openai-api-key", {
      type: "string",
      description: "OpenAI API key.",
      default: process.env.OPENAI_API_KEY,
    })
    .option("openai-model", {
      type: "string",
      description: "OpenAI model identifier.",
      default: process.env.OPENAI_REVIEW_MODEL ?? DEFAULT_MODEL,
    })
    .option("max-output-tokens", {
      type: "number",
      description: "Maximum tokens for the Codex response.",
      default: 1024,
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
    .option("azure-token", {
      type: "string",
      description:
        "Azure DevOps Personal Access Token (defaults to AZURE_DEVOPS_PAT or SYSTEM_ACCESSTOKEN).",
      default: process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN,
    })
    .help()
    .parseSync();

  return {
    prId: argv.prId as number | undefined,
    organization: argv.organization as string | undefined,
    project: argv.project as string | undefined,
    repository: argv.repository as string | undefined,
    repositoryId: argv.repositoryId as string | undefined,
    targetBranch: argv.targetBranch as string | undefined,
    sourceRef: argv.sourceRef as string | undefined,
    diffFile: argv.diffFile as string | undefined,
    maxFiles: argv.maxFiles as number,
    maxDiffChars: argv.maxDiffChars as number,
    openaiApiKey: argv.openaiApiKey as string | undefined,
    openaiModel: argv.openaiModel as string,
    maxOutputTokens: argv.maxOutputTokens as number,
    dryRun: Boolean(argv.dryRun),
    debug: Boolean(argv.debug),
    outputJson: argv.outputJson as string | undefined,
    azureToken: argv.azureToken as string | undefined,
  };
}

async function runCommand(
  command: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  const [file, ...args] = command;
  logger.debug("Running command:", command.join(" "));
  try {
    const { stdout } = await execFileAsync(file, args, {
      env: process.env,
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
    throw new ReviewError(
      `Command ${command.join(" ")} failed: ${stderr.trim() || err.message}`,
    );
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

  if (options.targetBranch) {
    try {
      return await gitDiff(options);
    } catch (error) {
      logger.warn("git diff failed:", (error as Error).message);
    }
  }

  throw new ReviewError(
    "No diff source available. Provide --diff-file or --target-branch.",
  );
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
  const sourceRef = options.sourceRef ?? "HEAD";
  logger.info("Computing git diff", `${fetchRef}...${sourceRef}`);
  const diff = await runCommand([
    "git",
    "diff",
    "--unified=3",
    `${fetchRef}...${sourceRef}`,
  ]);
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
        currentPath = pathToken.startsWith("a/")
          ? pathToken.slice(2)
          : pathToken;
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

function truncateFiles(
  files: FileDiff[],
  maxFiles: number,
  maxChars: number,
): FileDiff[] {
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
    throw new ReviewError(
      "Diff too large to include in prompt. Increase max-diff-chars.",
    );
  }

  return result;
}

function buildPrompt(files: FileDiff[]): string {
  const sections = files.map(
    (file) => `File: ${file.path}\n\`\`\`\n${file.diff}\n\`\`\``,
  );
  return sections.join("\n\n");
}

async function callOpenAI(
  options: CliOptions,
  prompt: string,
): Promise<string> {
  if (!options.openaiApiKey) {
    throw new ReviewError("OPENAI_API_KEY not provided.");
  }

  const client = new OpenAI({ apiKey: options.openaiApiKey });
  const systemPrompt = [
    "You are an autonomous code-review assistant focused on actionable feedback.",
    "Analyze the provided unified diff for a pull request and respond in JSON using this structure:",
    "{",
    '  "summary": "Overall summary of the changes and review perspective.",',
    '  "findings": [',
    "    {",
    '      "severity": "critical|major|minor|nit",',
    '      "file": "path/to/file",',
    '      "line": 123,',
    '      "title": "Short issue label",',
    '      "details": "Detailed explanation and guidance."',
    "    }",
    "  ],",
    '  "suggestions": [',
    "    {",
    '      "file": "path/to/file",',
    '      "start_line": 10,',
    '      "end_line": 12,',
    '      "comment": "Comment that will precede a suggestion.",',
    '      "replacement": "Replacement code to place inside ```suggestion``` block."',
    "    }",
    "  ]",
    "}",
    "Only respond with valid JSON.",
  ].join("\n");

  logger.info("Requesting review from OpenAI model", options.openaiModel);
  const response = await client.responses.create({
    model: options.openaiModel,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_output_tokens: options.maxOutputTokens,
  });

  const rawOutput = extractOutputText(response);
  logger.debug("Raw model output:", rawOutput);
  return rawOutput;
}

function extractOutputText(response: unknown): string {
  const payload = response as Record<string, unknown>;
  if (
    typeof payload.output_text === "string" &&
    payload.output_text.trim().length > 0
  ) {
    return payload.output_text;
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    const chunks = [];
    for (const item of output) {
      if (item && typeof item === "object" && "content" in item) {
        const content = (item as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "text" in block) {
              const text = (block as Record<string, unknown>).text;
              if (typeof text === "string") {
                chunks.push(text);
              }
            }
          }
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join("");
    }
  }

  throw new ReviewError("Could not extract text from OpenAI response.");
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
  const findings = parsed.findings.map(
    (finding) => ({ ...finding }) as Record<string, unknown>,
  );
  const suggestions: ReviewSuggestion[] = parsed.suggestions.map(
    (suggestion) => ({
      file: suggestion.file,
      startLine: suggestion.start_line,
      endLine: suggestion.end_line ?? suggestion.start_line,
      comment: suggestion.comment.trim(),
      replacement: suggestion.replacement.replace(/\s+$/, ""),
    }),
  );

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

function buildFindingsSummary(
  findings: Array<Record<string, unknown>>,
): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const severity = String(finding.severity ?? "info").toUpperCase();
    const filePath = String(finding.file ?? "unknown");
    const line = finding.line !== undefined ? String(finding.line) : "?";
    const title = finding.title ? String(finding.title) : "";
    const details = finding.details ? String(finding.details) : "";
    lines.push(
      `- **${severity}** ${filePath}:${line} – ${title}\n  ${details}`,
    );
  }
  return lines;
}

function logReview(review: ReviewResult): void {
  logger.info("Review summary:\n", review.summary || "<no summary provided>");
  if (review.findings.length > 0) {
    logger.info("Findings:");
    for (const entry of review.findings) {
      logger.info("-", JSON.stringify(entry));
    }
  }
  if (review.suggestions.length > 0) {
    logger.info("Suggestions:");
    for (const suggestion of review.suggestions) {
      logger.info(
        `- ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine} -> ${suggestion.comment.replace(/\s+/g, " ").slice(0, 80)}`,
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
  if (!gitApi || !repositoryId) {
    logger.warn(
      "Git API unavailable; cannot post overall comment. Enable PAT and PR context.",
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

  await createThread(options, gitApi, repositoryId, thread);
}

async function postSuggestions(
  options: CliOptions,
  review: ReviewResult,
  gitApi?: IGitApi,
  repositoryId?: string,
): Promise<void> {
  if (review.suggestions.length === 0) {
    logger.info("No suggestions to post.");
    return;
  }

  for (const suggestion of review.suggestions) {
    const suggestionBlock = `${suggestion.comment}\n\n\`\`\`suggestion\n${suggestion.replacement}\n\`\`\``;

    if (options.dryRun) {
      logger.info(
        `Dry-run: would post suggestion to ${suggestion.file}:${suggestion.startLine}-${suggestion.endLine}\n${suggestionBlock}`,
      );
      continue;
    }

    if (!gitApi || !repositoryId) {
      logger.warn("Git API unavailable; skipping posting suggestion thread.");
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

    await createThread(options, gitApi, repositoryId, thread);
  }
}

async function createThread(
  options: CliOptions,
  gitApi: IGitApi,
  repositoryId: string,
  thread: GitInterfaces.GitPullRequestCommentThread,
): Promise<void> {
  if (!options.project) {
    throw new ReviewError(
      "Azure DevOps project name is required to post comments.",
    );
  }
  if (!options.prId) {
    throw new ReviewError("Pull request ID is required to post comments.");
  }

  logger.info("Posting review thread to PR", options.prId);
  await gitApi.createThread(
    thread,
    repositoryId,
    options.prId,
    options.project,
  );
}

async function ensureGitClient(
  options: CliOptions,
): Promise<{ gitApi: IGitApi; repositoryId: string }> {
  if (!options.organization) {
    throw new ReviewError(
      "Azure DevOps organization URL is required. Pass --organization.",
    );
  }
  if (!options.project) {
    throw new ReviewError(
      "Azure DevOps project name is required. Pass --project.",
    );
  }
  const token = options.azureToken;
  if (!token) {
    throw new ReviewError(
      "Azure DevOps PAT not provided. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }

  const orgUrl = options.organization.startsWith("http")
    ? options.organization.replace(/\/$/, "")
    : `https://dev.azure.com/${options.organization.replace(/^\//, "")}`;

  const authHandler = azdev.getPersonalAccessTokenHandler(token);
  const connection = new azdev.WebApi(orgUrl, authHandler);
  const gitApi = await connection.getGitApi();

  const repositoryId = await resolveRepositoryId(options, gitApi);
  return { gitApi, repositoryId };
}

async function resolveRepositoryId(
  options: CliOptions,
  gitApi: IGitApi,
): Promise<string> {
  if (options.repositoryId) {
    return options.repositoryId;
  }
  if (!options.repository) {
    throw new ReviewError(
      "Repository name or ID is required to post comments.",
    );
  }
  const repo = await gitApi.getRepository(options.repository, options.project);
  if (!repo?.id) {
    throw new ReviewError(
      `Could not resolve repository ID for ${options.repository}`,
    );
  }
  return repo.id;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger = createLogger(options.debug);

  try {
    const diffText = await loadDiff(options);
    const fileDiffs = parseUnifiedDiff(diffText);
    const truncated = truncateFiles(
      fileDiffs,
      options.maxFiles,
      options.maxDiffChars,
    );
    const prompt = buildPrompt(truncated);
    const rawJson = await callOpenAI(options, prompt);

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
    logger.info("Review completed successfully.");
  } catch (error) {
    const message =
      error instanceof ReviewError ? error.message : (error as Error).message;
    logger.error("Review failed:", message);
    process.exitCode = 1;
  }
}

void main();
