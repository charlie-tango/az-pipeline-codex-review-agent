import process from "node:process";

import { type SimpleGit, simpleGit } from "simple-git";

import { ensureGitClient, resolveOrganizationUrl } from "./azure.js";
import type { CliOptions } from "./cli.js";
import { runCommand } from "./command.js";
import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import type { FileDiff } from "./types.js";

const git: SimpleGit = simpleGit();

export type LoadedDiff = {
  diffText: string;
  sourceRef: string;
  sourceSha: string;
  targetRef: string;
  targetSha: string;
  baseSha?: string;
  comparisonDescription: string;
};

export async function loadDiff(options: CliOptions, sinceCommit?: string): Promise<LoadedDiff> {
  const logger = getLogger();

  const targetBranch = await determineTargetBranch(options);
  logger.info(
    "Using target branch %s for PR #%s",
    targetBranch,
    options.prId ?? "<unknown>",
  );

  try {
    return await gitDiff(targetBranch, sinceCommit);
  } catch (error) {
    const message = (error as Error).message;
    logger.warn("git diff failed: %s", message);
    throw new ReviewError(`Failed to load pull-request diff: ${message}`);
  }
}

async function determineTargetBranch(options: CliOptions): Promise<string> {
  const logger = getLogger();

  try {
    const resolved = await resolvePullRequestTargetBranch(options);
    const normalized = normalizeBranchRef(resolved);
    if (normalized) {
      return normalized;
    }
  } catch (error) {
    logger.warn(
      "Failed to resolve target branch from Azure DevOps: %s",
      (error as Error).message,
    );
  }

  const envTarget = resolveEnvTargetBranch();
  if (envTarget) {
    return envTarget;
  }

  throw new ReviewError(
    "Unable to determine pull-request target branch from Azure DevOps or environment.",
  );
}

function resolveEnvTargetBranch(): string | undefined {
  const candidates = [
    process.env.SYSTEM_PULLREQUEST_TARGETBRANCH,
    process.env.BUILD_SOURCEBRANCH,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBranchRef(candidate);
    if (normalized) {
      return normalized;
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

async function resolveSourceRef(): Promise<string> {
  if (await refExists("HEAD")) {
    return "HEAD";
  }
  throw new ReviewError("Source ref not available. Ensure the repository has a HEAD commit.");
}

async function refExists(ref: string): Promise<boolean> {
  return (await tryRevParse("--verify", `${ref}^{commit}`)) !== undefined;
}

async function tryRevParse(...args: string[]): Promise<string | undefined> {
  try {
    return (await git.revparse(args)).trim();
  } catch {
    return undefined;
  }
}

async function gitDiff(targetBranch: string, sinceCommit?: string): Promise<LoadedDiff> {
  const logger = getLogger();
  const branchName = targetBranch.startsWith("refs/heads/")
    ? targetBranch.slice("refs/heads/".length)
    : targetBranch.replace(/^origin\//, "");
  if (!branchName) {
    throw new ReviewError(`Unable to compute branch name from target ref: ${targetBranch}`);
  }
  const fetchRef = `origin/${branchName}`;

  await git.fetch("origin", branchName);

  const targetSha = (await git.revparse([fetchRef])).trim();
  const sourceRef = await resolveSourceRef();
  const sourceSha = (await git.revparse([sourceRef])).trim();

  let diffText = "";
  let comparisonDescription = "";
  let baseSha: string | undefined;

  if (sinceCommit) {
    const trimmed = sinceCommit.trim();
    if (trimmed.length > 0 && trimmed !== sourceSha && (await refExists(trimmed))) {
      baseSha = (await git.revparse([trimmed])).trim();
      comparisonDescription = `${baseSha}...${sourceSha}`;
      logger.info(
        "Computing incremental git diff %s...%s",
        baseSha.slice(0, 12),
        sourceSha.slice(0, 12),
      );
      diffText = await git.diff(["--unified=1", comparisonDescription]);
    } else if (trimmed.length > 0 && trimmed !== sourceSha) {
      logger.warn(
        "Previous review commit %s not found locally; falling back to full diff.",
        trimmed,
      );
    }
  }

  if (!comparisonDescription) {
    comparisonDescription = `${fetchRef}...${sourceRef}`;
    logger.info("Computing git diff %s", comparisonDescription);
    diffText = await git.diff(["--unified=1", comparisonDescription]);
  } else if (!diffText.trim()) {
    logger.info("No changes detected since %s; skipping incremental diff.", baseSha);
  }

  if (!diffText.trim()) {
    logger.info("git diff returned no changes.");
  }

  return {
    diffText,
    sourceRef,
    sourceSha,
    targetRef: fetchRef,
    targetSha,
    baseSha,
    comparisonDescription,
  };
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
