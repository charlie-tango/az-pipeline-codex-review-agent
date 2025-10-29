import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { ensureGitClient, resolveOrganizationUrl } from "./azure.js";
import type { CliOptions } from "./cli.js";
import { runCommand } from "./command.js";
import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import type { FileDiff } from "./types.js";

export async function loadDiff(options: CliOptions): Promise<string> {
  const logger = getLogger();
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

export async function inferTargetBranch(options: CliOptions): Promise<string | undefined> {
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
      getLogger().debug(
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

    const masterMatch = remoteInfo.match(/^\s+(?:remotes\/origin\/)?(master|main)\s*$/m);
    if (masterMatch?.[1]) {
      const normalized = normalizeBranchRef(masterMatch[1]);
      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

function normalizeBranchRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed;
  }
  if (trimmed.startsWith("refs/")) {
    return undefined;
  }
  return `refs/heads/${trimmed.replace(/^origin\//, "")}`;
}

async function resolveDefaultBranchFromAzure(options: CliOptions): Promise<string | undefined> {
  const { gitApi } = await ensureGitClient(options);
  const project = options.project;
  const repository = options.repository;
  if (!project || !repository) {
    return undefined;
  }
  const repo = await gitApi.getRepository(repository, project);
  return repo?.defaultBranch ?? undefined;
}

export async function resolvePullRequestTargetBranch(
  options: CliOptions,
): Promise<string | undefined> {
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
      getLogger().debug(
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
    getLogger().debug(
      "Failed to parse Azure CLI pull request payload: %s",
      (error as Error).message ?? String(error),
    );
    return undefined;
  }
}

async function resolveSourceRef(options: CliOptions): Promise<string> {
  const logger = getLogger();
  const sourceRef = options.sourceRef;

  if (sourceRef) {
    const resolved = await resolveExplicitSourceRef(sourceRef);
    if (resolved) {
      if (resolved !== sourceRef) {
        logger.debug("Resolved source ref %s to %s", sourceRef, resolved);
      }
      return resolved;
    }
    logger.warn(
      "Configured source ref %s not found locally; falling back to repository HEAD.",
      sourceRef,
    );
  }

  if (await refExists("HEAD")) {
    return "HEAD";
  }
  throw new ReviewError("Source ref not available. Ensure the repository has a HEAD commit.");
}

async function resolveExplicitSourceRef(ref: string): Promise<string | undefined> {
  if (await refExists(ref)) {
    return ref;
  }

  const logger = getLogger();
  const candidates = new Set<string>();
  const fetchTargets = new Set<string>();

  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length);
    candidates.add(`refs/remotes/origin/${branch}`);
    candidates.add(`origin/${branch}`);
    candidates.add(branch);
    fetchTargets.add(branch);
  } else if (ref.startsWith("refs/remotes/origin/")) {
    const branch = ref.slice("refs/remotes/origin/".length);
    candidates.add(`origin/${branch}`);
    candidates.add(`refs/heads/${branch}`);
    candidates.add(branch);
    fetchTargets.add(branch);
  } else if (ref.startsWith("refs/pull/")) {
    const prBranch = `${ref}`;
    candidates.add(prBranch);
    const mergeRef = `${prBranch}/merge`;
    const headRef = `${prBranch}/head`;
    candidates.add(mergeRef);
    candidates.add(headRef);
    fetchTargets.add(mergeRef);
    fetchTargets.add(headRef);
  } else if (ref.startsWith("origin/")) {
    const branch = ref.slice("origin/".length);
    candidates.add(`refs/remotes/origin/${branch}`);
    candidates.add(`refs/heads/${branch}`);
    candidates.add(branch);
    fetchTargets.add(branch);
  }

  for (const target of fetchTargets) {
    logger.debug("Fetching source branch origin/%s", target);
    await runCommand(["git", "fetch", "origin", target], { allowFailure: true });
  }

  for (const candidate of [ref, ...candidates]) {
    if (await refExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function refExists(ref: string): Promise<boolean> {
  try {
    await runCommand(["git", "rev-parse", "--verify", `${ref}^{commit}`]);
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
  const sourceRef = await resolveSourceRef(options);
  getLogger().info("Computing git diff", `${fetchRef}...${sourceRef}`);
  const diff = await runCommand(["git", "diff", "--unified=3", `${fetchRef}...${sourceRef}`]);
  if (!diff.trim()) {
    getLogger().warn("git diff returned no changes.");
  }
  return diff;
}

export function parseUnifiedDiff(diffText: string): FileDiff[] {
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

export function truncateFiles(files: FileDiff[], maxFiles: number, maxChars: number): FileDiff[] {
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

export function buildPrompt(files: FileDiff[]): string {
  const sections = files.map((file) => `File: ${file.path}\n\`\`\`\n${file.diff}\n\`\`\``);
  return sections.join("\n\n");
}
