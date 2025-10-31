import azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import type { CliOptions } from "./cli.js";
import { buildCommentSignature, normalizeThreadFilePath } from "./commentSignatures.js";
import { runCommand } from "./command.js";
import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";

const REVIEW_HEAD_REGEX = /<!--\s*codex-review-head:\s*([0-9a-f]{7,40})\s*-->/i;
const REVIEW_HEAD_REGEX_GLOBAL = /<!--\s*codex-review-head:\s*[0-9a-f]{7,40}\s*-->/gi;

function extractReviewHeadSha(content: string): string | undefined {
  const match = REVIEW_HEAD_REGEX.exec(content);
  return match?.[1];
}

function stripReviewMetadata(content: string): string {
  return content.replace(REVIEW_HEAD_REGEX_GLOBAL, "").trim();
}

export function resolveOrganizationUrl(org: string): string {
  if (org.startsWith("http")) {
    return org.replace(/\/$/, "");
  }
  return `https://dev.azure.com/${org.replace(/^\//, "")}`;
}

export async function ensureGitClient(
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

export function buildThreadsUrl(options: CliOptions, repositoryId: string): string {
  if (!options.project) {
    throw new ReviewError("Azure DevOps project name is required. Pass --project.");
  }
  if (!options.organization) {
    throw new ReviewError("Azure DevOps organization URL is required. Pass --organization.");
  }
  const orgUrl = resolveOrganizationUrl(options.organization);
  const projectSegment = encodeURIComponent(options.project);
  return `${orgUrl}/${projectSegment}/_apis/git/repositories/${repositoryId}/pullRequests/${options.prId}/threads?api-version=7.0`;
}

export type PullRequestMetadata = {
  targetRefName?: string;
  sourceRefName?: string;
  title?: string;
  description?: string;
};

export async function fetchPullRequestMetadata(
  options: CliOptions,
): Promise<PullRequestMetadata | undefined> {
  if (!options.prId) {
    return undefined;
  }

  const cliMetadata = await fetchPullRequestMetadataWithAzCli(options);
  if (cliMetadata) {
    return cliMetadata;
  }

  if (!options.azureToken) {
    throw new ReviewError(
      "Azure DevOps PAT is required to resolve pull request metadata. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }

  const { gitApi, repositoryId } = await ensureGitClient(options);
  const pr = await gitApi.getPullRequest(repositoryId, options.prId, options.project);
  if (!pr) {
    return undefined;
  }

  return {
    targetRefName: pr.targetRefName ?? undefined,
    sourceRefName: pr.sourceRefName ?? undefined,
    title: pr.title ?? undefined,
    description: pr.description ?? undefined,
  };
}

function buildAuthHeader(token: string): string {
  return Buffer.from(`:${token}`).toString("base64");
}

function isTextCommentType(value: unknown): boolean {
  if (value === GitInterfaces.CommentType.Text) {
    return true;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "text";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

export type ExistingCommentSummary = {
  content: string;
  rawContent: string;
  reviewHeadSha?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  threadId?: number;
  commentId?: number;
};

function recordThreadSignatures(
  thread:
    | GitInterfaces.GitPullRequestCommentThread
    | {
        comments?: Array<{ content?: string | null; commentType?: unknown }>;
        threadContext?: {
          filePath?: string | null;
          rightFileStart?: { line?: number | null };
          rightFileEnd?: { line?: number | null };
          leftFileStart?: { line?: number | null };
          leftFileEnd?: { line?: number | null };
        };
      },
  signatures: Set<string>,
  summaries?: ExistingCommentSummary[],
): void {
  const context = thread.threadContext;
  const filePath = context?.filePath ?? undefined;
  const startLine =
    context?.rightFileStart?.line ??
    context?.leftFileStart?.line ??
    context?.rightFileEnd?.line ??
    context?.leftFileEnd?.line ??
    undefined;
  const endLine =
    context?.rightFileEnd?.line ??
    context?.leftFileEnd?.line ??
    context?.rightFileStart?.line ??
    context?.leftFileStart?.line ??
    undefined;

  let summaryCaptured = false;

  for (const comment of thread.comments ?? []) {
    const content = typeof comment.content === "string" ? comment.content : undefined;
    if (!content) {
      continue;
    }
    if (
      "commentType" in comment &&
      comment.commentType !== undefined &&
      !isTextCommentType(comment.commentType)
    ) {
      continue;
    }
    const sanitizedContent = stripReviewMetadata(content);
    if (!sanitizedContent) {
      continue;
    }
    const signature = buildCommentSignature({
      content: sanitizedContent,
      filePath: filePath ? normalizeThreadFilePath(filePath) : undefined,
      startLine: startLine ?? undefined,
      endLine: endLine ?? undefined,
    });
    if (signature) {
      signatures.add(signature);
      if (!summaryCaptured && summaries) {
        const threadId =
          "id" in (thread as GitInterfaces.GitPullRequestCommentThread)
            ? (thread as GitInterfaces.GitPullRequestCommentThread).id
            : undefined;
        const commentId =
          "id" in comment && typeof (comment as { id?: number }).id === "number"
            ? (comment as { id?: number }).id
            : undefined;
        summaries.push({
          content: sanitizedContent,
          rawContent: content,
          reviewHeadSha: extractReviewHeadSha(content),
          filePath: filePath ?? undefined,
          startLine: startLine ?? undefined,
          endLine: endLine ?? undefined,
          threadId,
          commentId,
        });
        summaryCaptured = true;
      }
    }
  }
}

type RestThread = {
  comments?: Array<{ content?: string | null; commentType?: unknown }>;
  threadContext?: {
    filePath?: string | null;
    rightFileStart?: { line?: number | null };
    rightFileEnd?: { line?: number | null };
    leftFileStart?: { line?: number | null };
    leftFileEnd?: { line?: number | null };
  };
};

export async function fetchExistingCommentSignatures(
  options: CliOptions,
  repositoryId?: string,
): Promise<{ signatures: Set<string>; summaries: ExistingCommentSummary[] }> {
  const signatures = new Set<string>();
  const summaries: ExistingCommentSummary[] = [];
  if (!options.prId) {
    return { signatures, summaries };
  }
  const resolvedRepositoryId = repositoryId ?? (await resolveRepositoryIdViaRest(options));
  if (!resolvedRepositoryId) {
    return { signatures, summaries };
  }

  try {
    const threads = await fetchThreadsViaRest(options, resolvedRepositoryId);
    for (const thread of threads) {
      recordThreadSignatures(thread, signatures, summaries);
    }
  } catch (error) {
    getLogger().warn(
      "Failed to fetch existing threads via REST API: %s",
      (error as Error).message,
    );
  }

  return { signatures, summaries };
}

export async function createThreadViaRest(
  options: CliOptions,
  repositoryId: string,
  thread: GitInterfaces.GitPullRequestCommentThread,
): Promise<void> {
  if (!options.organization) {
    throw new ReviewError("Azure DevOps organization URL is required. Pass --organization.");
  }
  const token = options.azureToken;
  if (!token) {
    throw new ReviewError(
      "Azure DevOps PAT not provided. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }
  const url = buildThreadsUrl(options, repositoryId);
  const logger = getLogger();

  logger.info("Posting review thread to PR %s via REST API", options.prId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${buildAuthHeader(token)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(thread),
  });

  if (response.ok) {
    return;
  }

  const errorBody = (await response.text()).trim();
  const truncatedError = errorBody.length > 500 ? `${errorBody.slice(0, 500)}?` : errorBody;
  throw new ReviewError(
    `Azure DevOps REST create thread failed (${response.status} ${response.statusText})${
      truncatedError ? `: ${truncatedError}` : ""
    }`,
  );
}

export type { IGitApi };
export { GitInterfaces };

async function fetchThreadsViaRest(
  options: CliOptions,
  repositoryId: string,
): Promise<RestThread[]> {
  const token = options.azureToken;
  if (!token) {
    throw new ReviewError(
      "Azure DevOps PAT not provided. Set AZURE_DEVOPS_PAT, SYSTEM_ACCESSTOKEN, or pass --azure-token.",
    );
  }

  const url = buildThreadsUrl(options, repositoryId);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${buildAuthHeader(token)}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = (await response.text()).trim();
    throw new ReviewError(
      `Azure DevOps REST list threads failed (${response.status} ${response.statusText})${
        errorBody ? `: ${errorBody}` : ""
      }`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (Array.isArray(payload)) {
    return payload as RestThread[];
  }
  if (Array.isArray((payload as { value?: RestThread[] }).value)) {
    return ((payload as { value?: RestThread[] }).value ?? []) as RestThread[];
  }
  return [];
}

async function fetchPullRequestMetadataWithAzCli(
  options: CliOptions,
): Promise<PullRequestMetadata | undefined> {
  if (!options.project || !options.organization || !options.prId) {
    return undefined;
  }

  if (!options.azureToken) {
    return undefined;
  }

  const env = {
    ...process.env,
    AZURE_DEVOPS_EXT_PAT: options.azureToken ?? process.env.AZURE_DEVOPS_EXT_PAT,
  };

  const orgUrl = resolveOrganizationUrl(options.organization);
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
    const payload = JSON.parse(stdout) as {
      targetRefName?: string | null;
      sourceRefName?: string | null;
      title?: string | null;
      description?: string | null;
    };
    return {
      targetRefName: payload.targetRefName ?? undefined,
      sourceRefName: payload.sourceRefName ?? undefined,
      title: payload.title ?? undefined,
      description: payload.description ?? undefined,
    };
  } catch (error) {
    getLogger().debug(
      "Failed to parse Azure CLI pull request payload: %s",
      (error as Error).message ?? String(error),
    );
    return undefined;
  }
}

export async function resolveRepositoryIdViaRest(options: CliOptions): Promise<string | undefined> {
  if (options.repositoryId) {
    return options.repositoryId;
  }
  if (!options.repository) {
    throw new ReviewError("Repository name is required to resolve repository ID.");
  }
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
  const projectSegment = encodeURIComponent(options.project);
  const repositorySegment = encodeURIComponent(options.repository);
  const url = `${orgUrl}/${projectSegment}/_apis/git/repositories/${repositorySegment}?api-version=7.0`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${buildAuthHeader(token)}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = (await response.text()).trim();
    throw new ReviewError(
      `Azure DevOps REST repository lookup failed (${response.status} ${response.statusText})${
        errorBody ? `: ${errorBody}` : ""
      }`,
    );
  }

  const payload = (await response.json()) as { id?: string };
  if (!payload?.id) {
    throw new ReviewError(`Azure DevOps REST repository lookup did not return an ID for ${options.repository}`);
  }
  return payload.id;
}
