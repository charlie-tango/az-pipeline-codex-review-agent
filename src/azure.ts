import azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import type { CliOptions } from "./cli";
import { buildCommentSignature, normalizeThreadFilePath } from "./commentSignatures";
import { ReviewError } from "./errors";
import { getLogger } from "./logging";

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

  for (const comment of thread.comments ?? []) {
    const content =
      typeof comment.content === "string" ? comment.content : undefined;
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
    const signature = buildCommentSignature({
      content,
      filePath: filePath ? normalizeThreadFilePath(filePath) : undefined,
      startLine: startLine ?? undefined,
      endLine: endLine ?? undefined,
    });
    if (signature) {
      signatures.add(signature);
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

async function fetchExistingCommentSignaturesViaRest(
  options: CliOptions,
  repositoryId: string,
): Promise<Set<string>> {
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
  const threads: RestThread[] = Array.isArray(payload)
    ? (payload as RestThread[])
    : Array.isArray((payload as { value?: RestThread[] }).value)
      ? ((payload as { value?: RestThread[] }).value ?? [])
      : [];

  const signatures = new Set<string>();
  for (const thread of threads) {
    recordThreadSignatures(thread, signatures);
  }
  return signatures;
}

export async function fetchExistingCommentSignatures(
  options: CliOptions,
  repositoryId?: string,
  gitApi?: IGitApi,
): Promise<Set<string>> {
  const logger = getLogger();
  const signatures = new Set<string>();
  if (!options.prId || !repositoryId) {
    return signatures;
  }

  if (gitApi) {
    try {
      const threads = await gitApi.getThreads(repositoryId, options.prId, options.project);
      for (const thread of threads ?? []) {
        recordThreadSignatures(thread, signatures);
      }
      return signatures;
    } catch (error) {
      logger.warn(
        "Failed to fetch existing threads via Azure DevOps client: %s",
        (error as Error).message,
      );
    }
  }

  try {
    const restSignatures = await fetchExistingCommentSignaturesViaRest(options, repositoryId);
    for (const signature of restSignatures) {
      signatures.add(signature);
    }
  } catch (error) {
    logger.warn(
      "Failed to fetch existing threads via REST API: %s",
      (error as Error).message,
    );
  }

  return signatures;
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
  const truncatedError = errorBody.length > 500 ? `${errorBody.slice(0, 500)}…` : errorBody;
  throw new ReviewError(
    `Azure DevOps REST create thread failed (${response.status} ${response.statusText})${
      truncatedError ? `: ${truncatedError}` : ""
    }`,
  );
}

export type { IGitApi };
export { GitInterfaces };
