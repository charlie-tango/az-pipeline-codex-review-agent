import azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import * as GitInterfaces from "azure-devops-node-api/interfaces/GitInterfaces.js";

import type { CliOptions } from "./cli.js";
import { buildCommentSignature, normalizeThreadFilePath } from "./commentSignatures.js";
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

export class AzureThreadService {
  constructor(private readonly options: CliOptions, private readonly gitApi?: IGitApi) {}

  async fetchExisting(
    repositoryId?: string,
  ): Promise<{ signatures: Set<string>; summaries: ExistingCommentSummary[] }> {
    const signatures = new Set<string>();
    const summaries: ExistingCommentSummary[] = [];

    if (!this.options.prId || !repositoryId) {
      return { signatures, summaries };
    }

    const clientThreads = await this.tryFetchWithClient(repositoryId);
    if (clientThreads) {
      for (const thread of clientThreads ?? []) {
        recordThreadSignatures(thread, signatures, summaries);
      }
      return { signatures, summaries };
    }

    await this.tryFetchWithRest(repositoryId, signatures, summaries);
    return { signatures, summaries };
  }

  private async tryFetchWithClient(
    repositoryId: string,
  ): Promise<GitInterfaces.GitPullRequestCommentThread[] | null> {
    if (!this.gitApi) {
      return null;
    }
    try {
      return await this.gitApi.getThreads(repositoryId, this.options.prId!, this.options.project);
    } catch (error) {
      getLogger().warn(
        "Failed to fetch existing threads via Azure DevOps client: %s",
        (error as Error).message,
      );
      return null;
    }
  }

  private async tryFetchWithRest(
    repositoryId: string,
    signatures: Set<string>,
    summaries: ExistingCommentSummary[],
  ): Promise<void> {
    try {
      const threads = await fetchThreadsViaRest(this.options, repositoryId);
      for (const thread of threads) {
        recordThreadSignatures(thread, signatures, summaries);
      }
    } catch (error) {
      getLogger().warn(
        "Failed to fetch existing threads via REST API: %s",
        (error as Error).message,
      );
    }
  }
}

export async function fetchExistingCommentSignatures(
  options: CliOptions,
  repositoryId?: string,
  gitApi?: IGitApi,
): Promise<{ signatures: Set<string>; summaries: ExistingCommentSummary[] }> {
  const service = new AzureThreadService(options, gitApi);
  return service.fetchExisting(repositoryId);
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
